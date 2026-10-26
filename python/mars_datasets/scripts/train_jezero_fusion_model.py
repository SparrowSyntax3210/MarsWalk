"""Train a resource-sized dual-stream image/terrain model for Jezero.

Targets are weak DTM-derived proxies, not independently verified safety labels.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, math, random, sys, time
from contextlib import nullcontext
from pathlib import Path
import numpy as np
import rasterio, torch
import torch.nn.functional as F
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window
from torch import nn
from torch.utils.data import DataLoader, Dataset

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data/processed/vision_prototype/jezero_ctx"
STACK_NAME = "jezero_full_scene_features_20m.tif"
IGNORE, CLASSES, SEED, PATCH, GROUP_PIXELS = 255, 3, 42, 256, 512
CLASS_NAMES = ["terrain_not_flagged", "steep_slope_proxy", "high_roughness_proxy"]
CHANNEL_NAMES = ["ctx_image_intensity", "elevation_m", "slope_deg", "aspect_east_component",
                 "aspect_north_component", "roughness_3x3_plane_rms_m", "relief_3x3_range_m", "valid_data_mask"]


def split_group(row):
    group = f"{int(row['row_off']) // GROUP_PIXELS}:{int(row['col_off']) // GROUP_PIXELS}".encode("ascii")
    bucket = hashlib.sha1(group).digest()[0] % 5
    return "train" if bucket < 3 else "validation" if bucket == 3 else "test"


def get_ranges(stack_path):
    with rasterio.open(stack_path) as src:
        sample = src.read((1, 2, 3, 4, 5, 6),
            out_shape=(6, max(1, src.height // 4), max(1, src.width // 4)),
            masked=True, resampling=Resampling.nearest, out_dtype="float32")
    names = {0:"ctx_image_intensity", 1:"elevation_m", 2:"slope_deg",
             4:"roughness_3x3_plane_rms_m", 5:"relief_3x3_range_m"}
    ranges = {"channel_names": CHANNEL_NAMES, "aspect_encoding":"sin/cos downslope azimuth",
              "stack_name":stack_path.name}
    for band, name in names.items():
        values = sample[band].compressed().astype(np.float64)
        values = values[np.isfinite(values)]
        if not values.size:
            raise RuntimeError(f"No valid samples for {name}")
        low, high = (0.0, 45.0) if name == "slope_deg" else np.percentile(values, [2, 98])
        if high <= low:
            high = low + 1.0
        ranges[name] = [float(low), float(high)]
    return ranges


def make_input(raw, ranges):
    data = np.asarray(raw.filled(np.nan), dtype=np.float32)
    _, height, width = data.shape
    x = np.zeros((8, height, width), dtype=np.float32)
    valid = np.all(np.isfinite(data), axis=0)
    for band, key, out in ((0,"ctx_image_intensity",0),(1,"elevation_m",1),
            (2,"slope_deg",2),(4,"roughness_3x3_plane_rms_m",5),(5,"relief_3x3_range_m",6)):
        low, high = ranges[key]
        good = np.isfinite(data[band]) & valid
        x[out, good] = np.clip((data[band, good] - low) / (high - low), 0, 1)
    good = np.isfinite(data[3]) & valid
    radians = np.deg2rad(np.where(good, data[3], 0.0))
    x[3, good], x[4, good] = np.sin(radians[good]), np.cos(radians[good])
    x[7] = valid.astype(np.float32)
    return x, valid


class PatchDataset(Dataset):
    def __init__(self, rows, root, ranges, augment=False):
        self.rows, self.root, self.ranges, self.augment = rows, root, ranges, augment
        self.src = rasterio.open(root / STACK_NAME)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        height, width = int(row["height"]), int(row["width"])
        window = Window(int(row["col_off"]), int(row["row_off"]), width, height)
        raw = self.src.read((1,2,3,4,5,6), window=window, masked=True, out_dtype="float32")
        x, _ = make_input(raw, self.ranges)
        with Image.open(self.root / row["mask_path"]) as im:
            y = np.asarray(im, dtype=np.uint8).copy()
        x = np.pad(x, ((0,0),(0,PATCH-height),(0,PATCH-width)))
        y = np.pad(y, ((0,PATCH-height),(0,PATCH-width)), constant_values=IGNORE)
        x, y = torch.from_numpy(x), torch.from_numpy(y.astype(np.int64))
        if self.augment:
            if random.random() < .5:
                x, y = torch.flip(x,(-1,)), torch.flip(y,(-1,))
                x[3].neg_()
            if random.random() < .5:
                x, y = torch.flip(x,(-2,)), torch.flip(y,(-2,))
                x[4].neg_()
            if random.random() < .5:
                x, y = x.transpose(-1,-2), y.transpose(-1,-2)
                east, north = x[3].clone(), x[4].clone()
                x[3], x[4] = north, east
            if random.random() < .7:
                gain, offset = random.uniform(.8,1.2), random.uniform(-.08,.08)
                noise = torch.randn_like(x[0]) * random.uniform(0,.015)
                x[0] = (x[0] * gain + offset + noise).clamp_(0,1)
        return x, y


def group_count(channels):
    return next(g for g in range(min(8,channels),0,-1) if channels % g == 0)


class ResidualConvBlock(nn.Module):
    def __init__(self, in_channels, out_channels):
        super().__init__()
        self.conv1 = nn.Conv2d(in_channels,out_channels,3,padding=1,bias=False)
        self.norm1 = nn.GroupNorm(group_count(out_channels),out_channels)
        self.conv2 = nn.Conv2d(out_channels,out_channels,3,padding=1,bias=False)
        self.norm2 = nn.GroupNorm(group_count(out_channels),out_channels)
        self.shortcut = nn.Identity() if in_channels == out_channels else nn.Conv2d(in_channels,out_channels,1,bias=False)
        hidden = max(4,out_channels//4)
        self.channel_gate = nn.Sequential(nn.AdaptiveAvgPool2d(1),nn.Conv2d(out_channels,hidden,1),
            nn.SiLU(inplace=True),nn.Conv2d(hidden,out_channels,1),nn.Sigmoid())

    def forward(self,x):
        residual = self.shortcut(x)
        y = F.silu(self.norm1(self.conv1(x)))
        y = self.norm2(self.conv2(y))
        return F.silu(residual + y * self.channel_gate(y))


class CrossModalGate(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.terrain_to_image = nn.Conv2d(channels,channels,1)
        self.image_to_terrain = nn.Conv2d(channels,channels,1)
        self.project = nn.Sequential(nn.Conv2d(channels*2,channels,1,bias=False),
            nn.GroupNorm(group_count(channels),channels),nn.SiLU(inplace=True))
        self.spatial_gate = nn.Conv2d(channels*2,1,1)

    def forward(self,image,terrain):
        image_gated = image * torch.sigmoid(self.terrain_to_image(terrain))
        terrain_gated = terrain * torch.sigmoid(self.image_to_terrain(image))
        joined = torch.cat((image_gated,terrain_gated),dim=1)
        fused = self.project(joined) * torch.sigmoid(self.spatial_gate(joined))
        return F.silu(fused + .5*(image+terrain))


class JezeroFusionUNet(nn.Module):
    """Small residual U-Net with separate image/geometry branches and gated fusion."""
    def __init__(self, mode="multimodal"):
        super().__init__()
        if mode not in {"multimodal","image_only","terrain_only"}:
            raise ValueError(f"Unknown model mode: {mode}")
        self.mode, widths = mode, (16,32,48)
        self.pool = nn.MaxPool2d(2)
        self.image1, self.terrain1 = ResidualConvBlock(1,widths[0]), ResidualConvBlock(7,widths[0])
        self.fuse1 = CrossModalGate(widths[0])
        self.image2, self.terrain2 = ResidualConvBlock(widths[0],widths[1]), ResidualConvBlock(widths[0],widths[1])
        self.fuse2 = CrossModalGate(widths[1])
        self.image3, self.terrain3 = ResidualConvBlock(widths[1],widths[2]), ResidualConvBlock(widths[1],widths[2])
        self.fuse3 = CrossModalGate(widths[2])
        self.mid = ResidualConvBlock(widths[2],64)
        self.up3, self.dec3 = nn.ConvTranspose2d(64,widths[2],2,2), ResidualConvBlock(widths[2]*2,widths[2])
        self.up2, self.dec2 = nn.ConvTranspose2d(widths[2],widths[1],2,2), ResidualConvBlock(widths[1]*2,widths[1])
        self.up1, self.dec1 = nn.ConvTranspose2d(widths[1],widths[0],2,2), ResidualConvBlock(widths[0]*2,widths[0])
        self.out = nn.Conv2d(widths[0],CLASSES,1)

    def forward(self,x):
        image, terrain = x[:,:1], x[:,1:]
        if self.mode == "image_only":
            terrain = torch.zeros_like(terrain)
        elif self.mode == "terrain_only":
            image = torch.zeros_like(image)
        i1,t1 = self.image1(image), self.terrain1(terrain)
        f1 = self.fuse1(i1,t1)
        i2,t2 = self.image2(self.pool(i1)), self.terrain2(self.pool(t1))
        f2 = self.fuse2(i2,t2)
        i3,t3 = self.image3(self.pool(i2)), self.terrain3(self.pool(t2))
        f3 = self.fuse3(i3,t3)
        z = self.mid(self.pool(f3))
        z = self.dec3(torch.cat((self.up3(z),f3),1))
        z = self.dec2(torch.cat((self.up2(z),f2),1))
        z = self.dec1(torch.cat((self.up1(z),f1),1))
        return self.out(z)

def class_weights(rows,root):
    counts=np.zeros(CLASSES,dtype=np.int64)
    for row in rows:
        with Image.open(root/row["mask_path"]) as im: labels=np.asarray(im,dtype=np.uint8)
        labels=labels[labels<CLASSES]
        counts+=np.bincount(labels,minlength=CLASSES)[:CLASSES]
    if np.any(counts==0):
        raise RuntimeError(f"Training split missing classes: {np.flatnonzero(counts==0).tolist()}")
    frequency=counts/counts.sum()
    weights=np.sqrt(frequency.mean()/frequency)
    weights=np.clip(weights,.5,4.0); weights/=weights.mean()
    print("Training proxy pixels:",counts.tolist(),"class weights:",weights.round(3).tolist(),flush=True)
    return torch.tensor(weights,dtype=torch.float32)


def segmentation_loss(logits,target,weights):
    valid=target!=IGNORE
    if not torch.any(valid): return logits.sum()*0.0
    safe=target.clamp(0,CLASSES-1)
    probs=torch.softmax(logits,dim=1)
    ce=F.cross_entropy(logits,safe,weight=weights,reduction="none")
    true_prob=probs.gather(1,safe.unsqueeze(1)).squeeze(1)
    focal=(ce*(1.0-true_prob).pow(1.5))[valid].mean()
    mask=valid.unsqueeze(1).float()
    onehot=F.one_hot(safe,CLASSES).permute(0,3,1,2).float()*mask
    probs=probs*mask
    dices=[]
    for class_id in range(CLASSES):
        truth=onehot[:,class_id]
        if truth.sum()==0: continue
        pred=probs[:,class_id]
        dice=(2*(pred*truth).sum()+1)/(pred.sum()+truth.sum()+1)
        dices.append(1-dice)
    return focal+.25*(torch.stack(dices).mean() if dices else focal*0)


def metric_report(conf,brier_sum=0.0,valid_count=0,bins=None):
    diagonal=np.diag(conf).astype(float)
    true=conf.sum(1).astype(float); predicted=conf.sum(0).astype(float)
    union=true+predicted-diagonal
    iou=np.divide(diagonal,union,out=np.full(CLASSES,np.nan),where=union>0)
    recall=np.divide(diagonal,true,out=np.full(CLASSES,np.nan),where=true>0)
    precision=np.divide(diagonal,predicted,out=np.full(CLASSES,np.nan),where=predicted>0)
    tp=float(conf[1:,1:].sum()); fn=float(conf[1:,:].sum()-tp); fp=float(conf[:,1:].sum()-tp)
    hr=tp/max(1.0,tp+fn); hp=tp/max(1.0,tp+fp)
    f1=2*hp*hr/max(1e-12,hp+hr); f2=5*hp*hr/max(1e-12,4*hp+hr)
    out={
        "pixel_accuracy_vs_weak_labels":float(diagonal.sum()/max(1,conf.sum())),
        "class_iou_vs_weak_labels":{str(i):None if not np.isfinite(iou[i]) else float(iou[i]) for i in range(CLASSES)},
        "class_recall_vs_weak_labels":{str(i):None if not np.isfinite(recall[i]) else float(recall[i]) for i in range(CLASSES)},
        "class_precision_vs_weak_labels":{str(i):None if not np.isfinite(precision[i]) else float(precision[i]) for i in range(CLASSES)},
        "hazard_proxy_precision_vs_weak_labels_classes_1_2":float(hp),
        "hazard_proxy_recall_vs_weak_labels_classes_1_2":float(hr),
        "hazard_proxy_f1_vs_weak_labels_classes_1_2":float(f1),
        "hazard_proxy_f2_vs_weak_labels_classes_1_2":float(f2),
        "confusion_matrix_rows_true_cols_predicted":conf.tolist(),
        "evaluated_pixels":int(conf.sum()),
    }
    if valid_count: out["hazard_probability_brier_vs_weak_labels"]=float(brier_sum/valid_count)
    if bins is not None:
        total=sum(x[0] for x in bins)
        out["hazard_probability_ece_10_bins_vs_weak_labels"]=float(
            sum(n*abs(pc-pt) for n,pc,pt in bins if n)/max(1,total))
    return out


def evaluate(model,loader,device,weights,amp_enabled):
    confusion=np.zeros((CLASSES,CLASSES),dtype=np.int64)
    loss_total=0.0; batch_count=0; brier=0.0; valid_count=0
    bin_count=np.zeros(10,dtype=np.int64); bin_conf=np.zeros(10); bin_true=np.zeros(10)
    model.eval()
    with torch.inference_mode():
        for x,y in loader:
            x,y=x.to(device,non_blocking=True),y.to(device,non_blocking=True)
            context=torch.autocast("cuda",dtype=torch.float16) if amp_enabled else nullcontext()
            with context:
                logits=model(x); loss=segmentation_loss(logits,y,weights)
            loss_total+=float(loss); batch_count+=1
            valid=y!=IGNORE; pred=logits.argmax(1)
            encoded=(y[valid]*CLASSES+pred[valid]).cpu().numpy()
            confusion+=np.bincount(encoded,minlength=CLASSES*CLASSES).reshape(CLASSES,CLASSES)
            ph=torch.softmax(logits,1)[:,1:].sum(1)[valid].float()
            th=((y>=1)&valid)[valid].float()
            if ph.numel():
                brier+=float(((ph-th)**2).sum()); valid_count+=int(ph.numel())
                ids=torch.clamp((ph*10).long(),max=9)
                for i in range(10):
                    selected=ids==i; amount=int(selected.sum())
                    if amount:
                        bin_count[i]+=amount; bin_conf[i]+=float(ph[selected].sum()); bin_true[i]+=float(th[selected].sum())
    bins=[(int(bin_count[i]),float(bin_conf[i]/bin_count[i]),float(bin_true[i]/bin_count[i]))
          if bin_count[i] else (0,0.0,0.0) for i in range(10)]
    result=metric_report(confusion,brier,valid_count,bins)
    result["loss_vs_weak_labels"]=loss_total/max(1,batch_count)
    return result


def train_variant(name,train_loader,val_loader,weights,device,args,checkpoint=None):
    torch.manual_seed(SEED)
    model=JezeroFusionUNet(name).to(device)
    optimizer=torch.optim.AdamW(model.parameters(),lr=args.learning_rate,weight_decay=1e-4)
    scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer,mode="max",factor=.5,patience=2,min_lr=1e-6)
    amp_enabled=device.type=="cuda" and not args.no_amp
    try: scaler=torch.amp.GradScaler("cuda",enabled=amp_enabled)
    except (AttributeError,TypeError): scaler=torch.cuda.amp.GradScaler(enabled=amp_enabled)
    best_score=-math.inf; best_loss=math.inf; best_epoch=0; stale=0; history=[]; best_state=None
    for epoch in range(1,args.epochs+1):
        model.train(); total=0.0; batches=0
        for x,y in train_loader:
            x,y=x.to(device,non_blocking=True),y.to(device,non_blocking=True)
            optimizer.zero_grad(set_to_none=True)
            context=torch.autocast("cuda",dtype=torch.float16) if amp_enabled else nullcontext()
            with context: loss=segmentation_loss(model(x),y,weights)
            scaler.scale(loss).backward(); scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(),1.0)
            scaler.step(optimizer); scaler.update()
            total+=float(loss.detach()); batches+=1
        train_loss=total/max(1,batches)
        validation=evaluate(model,val_loader,device,weights,amp_enabled)
        score=validation["hazard_proxy_f2_vs_weak_labels_classes_1_2"]
        scheduler.step(score)
        history.append({"epoch":epoch,"train_loss":train_loss,
            "validation_loss":validation["loss_vs_weak_labels"],
            "validation_hazard_f2_vs_weak_labels":score,"learning_rate":optimizer.param_groups[0]["lr"]})
        print(f"{name} epoch {epoch}/{args.epochs}: train={train_loss:.4f} val={validation['loss_vs_weak_labels']:.4f} hazard-F2={score:.3f} lr={optimizer.param_groups[0]['lr']:.2g}",flush=True)
        improved=score>best_score+1e-5 or (abs(score-best_score)<=1e-5 and validation["loss_vs_weak_labels"]<best_loss)
        if improved:
            best_score,best_loss,best_epoch,stale=score,validation["loss_vs_weak_labels"],epoch,0
            best_state={key:value.detach().cpu().clone() for key,value in model.state_dict().items()}
            if checkpoint: torch.save(best_state,checkpoint)
        else:
            stale+=1
            if stale>=args.patience:
                print(f"{name}: early stop at epoch {epoch}",flush=True); break
    if best_state is None: raise RuntimeError(f"No checkpoint recorded for {name}")
    model.load_state_dict(best_state)
    return model,{"best_epoch":best_epoch,"best_validation_hazard_f2":best_score,"history":history}


def infer_full_scene(model,root,ranges,device,amp_enabled):
    """Predict over every valid scene pixel, including areas without weak-label patches."""
    stack_path=root/STACK_NAME
    output=root/"jezero_visual_hazard_probability_multimodal_experimental.tif"
    temporary=output.with_name(output.stem+".tmp.tif")
    model.eval()
    with rasterio.open(stack_path) as src:
        profile=src.profile.copy()
        profile.update(driver="GTiff",count=4,dtype="float32",nodata=-9999.0,
            compress="deflate",predictor=3,tiled=True,blockxsize=256,blockysize=256)
        valid_total=0; total_pixels=src.width*src.height
        with rasterio.open(temporary,"w",**profile) as dst:
            descriptions=("p_terrain_not_flagged","p_steep_slope_proxy","p_high_roughness_proxy","p_hazard_proxy_sum_classes_1_2")
            for band,name in enumerate(descriptions,1): dst.set_band_description(band,name)
            dst.update_tags(model_status="experimental_dual_stream_gated_fusion_weak_label_model",
                architecture="image and terrain branches with cross-modal gated fusion and residual U-Net decoder",
                input_bands="CTX intensity, elevation, TTA slope, sin/cos downslope aspect, plane residual roughness, 3x3 relief",
                label_source="weak DTM-derived slope and roughness proxies; no independent human hazard labels",
                probability_warning="scores are not calibrated safety probabilities")
            for row0 in range(0,src.height,PATCH):
                height=min(PATCH,src.height-row0)
                for col0 in range(0,src.width,PATCH):
                    width=min(PATCH,src.width-col0)
                    window=Window(col0,row0,width,height)
                    raw=src.read((1,2,3,4,5,6),window=window,masked=True,out_dtype="float32")
                    x,valid=make_input(raw,ranges); valid_total+=int(valid.sum())
                    pad=np.pad(x,((0,0),(0,PATCH-height),(0,PATCH-width)))
                    tensor=torch.from_numpy(pad[None]).to(device,non_blocking=True)
                    context=torch.autocast("cuda",dtype=torch.float16) if amp_enabled else nullcontext()
                    with torch.inference_mode(),context:
                        probs=torch.softmax(model(tensor),1)[0].float().cpu().numpy()[:,:height,:width]
                    hazard=np.clip(probs[1]+probs[2],0,1)
                    tile=np.concatenate((probs,hazard[None]),axis=0).astype(np.float32)
                    tile[:,~valid]=-9999.0
                    dst.write(tile,window=window)
                print(f"Prediction rows {min(row0+height,src.height):,}/{src.height:,}",flush=True)
    temporary.replace(output)
    return output,valid_total/max(1,total_pixels)

def main():
    parser=argparse.ArgumentParser(description="Train a Jezero gated-fusion terrain/image model and modality ablations.")
    parser.add_argument("--data",type=Path,default=DEFAULT_DATA)
    parser.add_argument("--epochs",type=int,default=24)
    parser.add_argument("--batch-size",type=int,default=2)
    parser.add_argument("--patience",type=int,default=6)
    parser.add_argument("--learning-rate",type=float,default=3e-4)
    parser.add_argument("--ablation",action="store_true",
        help="Also train image-only and terrain-only models on the same spatial split.")
    parser.add_argument("--no-predict",action="store_true")
    parser.add_argument("--no-amp",action="store_true")
    args=parser.parse_args()
    if args.epochs<1 or args.batch_size<1 or args.patience<1 or args.learning_rate<=0:
        parser.error("epochs, batch-size, patience, and learning-rate must be positive")
    root=args.data; stack=root/STACK_NAME; manifest_path=root/"manifest.csv"
    if not stack.is_file() or not manifest_path.is_file() or not (root/"metadata.json").is_file():
        raise FileNotFoundError("Required Jezero stack, patch manifest, or prototype metadata is missing.")
    random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(SEED)
        torch.backends.cudnn.benchmark=True
    torch.set_num_threads(min(8,max(1,__import__("os").cpu_count() or 1)))
    with manifest_path.open(newline="",encoding="utf-8-sig") as stream:
        rows=list(csv.DictReader(stream))
    if len(rows)<20: raise RuntimeError(f"Only {len(rows)} patches are available.")
    for row in rows:
        row["split"]=split_group(row)
        for key in ("image_path","mask_path"):
            if not (root/row[key]).is_file(): raise FileNotFoundError(root/row[key])
    splits={name:[row for row in rows if row["split"]==name] for name in ("train","validation","test")}
    print("Spatially held-out patches:",{name:len(items) for name,items in splits.items()},flush=True)
    if min(map(len,splits.values()))<4: raise RuntimeError("A split has too few independent spatial patches.")
    model_dir=root/"model"; model_dir.mkdir(parents=True,exist_ok=True)
    with (model_dir/"spatial_split.csv").open("w",newline="",encoding="utf-8") as stream:
        writer=csv.DictWriter(stream,fieldnames=("patch_id","split","spatial_block")); writer.writeheader()
        for row in rows:
            writer.writerow({"patch_id":row["patch_id"],"split":row["split"],
                "spatial_block":f"{int(row['row_off'])//GROUP_PIXELS}:{int(row['col_off'])//GROUP_PIXELS}"})
    ranges=get_ranges(stack)
    (model_dir/"multimodal_input_ranges.json").write_text(json.dumps(ranges,indent=2),encoding="utf-8")
    train_ds=PatchDataset(splits["train"],root,ranges,augment=True)
    val_ds=PatchDataset(splits["validation"],root,ranges)
    test_ds=PatchDataset(splits["test"],root,ranges)
    pin=torch.cuda.is_available()
    train_loader=DataLoader(train_ds,batch_size=args.batch_size,shuffle=True,num_workers=0,pin_memory=pin)
    val_loader=DataLoader(val_ds,batch_size=args.batch_size,shuffle=False,num_workers=0,pin_memory=pin)
    test_loader=DataLoader(test_ds,batch_size=args.batch_size,shuffle=False,num_workers=0,pin_memory=pin)
    weights=class_weights(splits["train"],root)
    device=torch.device("cuda" if torch.cuda.is_available() else "cpu")
    amp_enabled=device.type=="cuda" and not args.no_amp
    gpu=torch.cuda.get_device_name(0) if device.type=="cuda" else None
    if gpu:
        print(f"Device: {gpu}; VRAM: {torch.cuda.get_device_properties(0).total_memory/2**30:.2f} GiB; AMP={amp_enabled}",flush=True)
    else:
        print("Device: CPU; CUDA-enabled PyTorch is required to use the installed RTX GPU.",flush=True)
    variants=["multimodal","image_only","terrain_only"] if args.ablation else ["multimodal"]
    checkpoint=model_dir/"jezero_multimodal_unet.pt"
    ablations={}; primary=None; started=time.time()
    for variant in variants:
        model,fit=train_variant(variant,train_loader,val_loader,weights.to(device),device,args,
            checkpoint=checkpoint if variant=="multimodal" else None)
        test_metrics=evaluate(model,test_loader,device,weights.to(device),amp_enabled)
        ablations[variant]={"fit":fit,"test_metrics_vs_weak_labels":test_metrics}
        if variant=="multimodal": primary=model
        else: del model
        if device.type=="cuda": torch.cuda.empty_cache()
    if primary is None: raise RuntimeError("No multimodal model was trained.")
    primary.load_state_dict(torch.load(checkpoint,map_location=device,weights_only=True))
    report={
        "status":"experimental_jezero_gated_fusion_weak_label_model",
        "model":"dual-stream gated-fusion residual U-Net; image and terrain fused at three scales",
        "input_channels":CHANNEL_NAMES,
        "terrain_geometry_channels":["elevation_m","slope_deg","aspect_east_component","aspect_north_component",
            "roughness_3x3_plane_rms_m","relief_3x3_range_m"],
        "classes":{str(i):CLASS_NAMES[i] for i in range(CLASSES)},
        "label_source":"weak DTM-derived slope and roughness proxies; not human-verified visual hazards",
        "dune_detection":"not trained: no mapped dune positives are present in this Jezero CTX footprint",
        "route_integration":"optional soft A* probability cost; geometric TTA factors remain explicit in A*",
        "split_method":"geographically held-out 512-pixel blocks; one split shared by all model variants",
        "split_patch_counts":{name:len(items) for name,items in splits.items()},
        "device":str(device),"gpu":gpu,"mixed_precision":amp_enabled,
        "test_metrics_vs_weak_labels":ablations["multimodal"]["test_metrics_vs_weak_labels"],
        "modality_ablation_results":{name:entry["test_metrics_vs_weak_labels"] for name,entry in ablations.items()},
        "ablation_fit_details":{name:entry["fit"] for name,entry in ablations.items()},
        "limits_on_interpretation":[
            "Metrics measure agreement with weak terrain-threshold labels, not independent visual hazard accuracy.",
            "The fused model receives geometry used to create its proxy targets and can learn those rules rather than discover visual hazards.",
            "The test split contains only eight spatial patches; pixels inside a patch are spatially correlated.",
            "There are no human-reviewed sand, rock, crater-rim, or traversability labels in this prototype.",
            "TES, MCD, geology, and coarse mapped context remain at their native grid and are not treated as 20 m measurements.",
        ],
        "ablations":ablations,
        "training_seconds":round(time.time()-started,2),
    }
    if not args.no_predict:
        output,coverage=infer_full_scene(primary,root,ranges,device,amp_enabled)
        report["prediction_raster"]=str(output)
        report["prediction_valid_pixel_fraction"]=coverage
    metrics_path=model_dir/"multimodal_metrics.json"
    metrics_path.write_text(json.dumps(report,indent=2,allow_nan=False),encoding="utf-8")
    print("checkpoint:",checkpoint,"metrics:",metrics_path,flush=True)
    print(json.dumps({
        "device":report["device"],"gpu":gpu,"split_patch_counts":report["split_patch_counts"],
        "ablation_results":{
            name:{
                "precision":result["hazard_proxy_precision_vs_weak_labels_classes_1_2"],
                "recall":result["hazard_proxy_recall_vs_weak_labels_classes_1_2"],
                "f2":result["hazard_proxy_f2_vs_weak_labels_classes_1_2"],
            } for name,result in report["modality_ablation_results"].items()},
        "prediction_raster":report.get("prediction_raster"),
        "prediction_valid_pixel_fraction":report.get("prediction_valid_pixel_fraction"),
    },indent=2),flush=True)
    return 0


if __name__=="__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Jezero gated-fusion training failed: {error}",file=sys.stderr)
        raise