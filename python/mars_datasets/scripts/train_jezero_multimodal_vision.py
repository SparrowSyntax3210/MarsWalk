"""Train Jezero multimodal segmentation against weak DTM-derived labels.
Targets are proxies, not human annotations or validated safety labels.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, math, random, sys
from pathlib import Path
import numpy as np
import rasterio, torch
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window
from torch import nn
from torch.utils.data import DataLoader, Dataset

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data/processed/vision_prototype/jezero_ctx"
STACK_NAME = "jezero_full_scene_features_20m.tif"
IGNORE, CLASSES, SEED = 255, 3, 42


def split_group(row):
    group = f"{int(row['row_off'])//512}:{int(row['col_off'])//512}".encode("ascii")
    bucket = hashlib.sha1(group).digest()[0] % 10
    return "train" if bucket < 7 else "validation" if bucket < 9 else "test"


def get_ranges(stack):
    with rasterio.open(stack) as src:
        h, w = min(src.height, 1024), min(src.width, 1024)
        sample = src.read((1,2,3,4,5,6), out_shape=(6,h,w), masked=True,
                          resampling=Resampling.nearest, out_dtype="float32")
    names = {0:"ctx_orthoimage_dn",1:"elevation_m",2:"slope_deg",4:"roughness_rms_m",5:"relief_range_m"}
    ranges = {"channel_names":["image","elevation","slope","aspect_east","aspect_north","roughness","relief"]}
    for i,name in names.items():
        values=sample[i].compressed().astype(np.float64)
        values=values[np.isfinite(values)]
        if not values.size: raise RuntimeError(f"No valid feature samples for {name}")
        lo,hi=(0.0,45.0) if name=="slope_deg" else np.percentile(values,[2,98])
        if hi<=lo: hi=lo+1.0
        ranges[name]=[float(lo),float(hi)]
    ranges["aspect_encoding"]="sin/cos down-slope azimuth; transforms with flips/transpose"
    ranges["feature_stack"]=str(stack)
    return ranges


def make_input(src, row, ranges):
    row_off,col_off=int(row["row_off"]),int(row["col_off"])
    h,w=int(row["height"]),int(row["width"])
    raw=src.read((1,2,3,4,5,6),window=Window(col_off,row_off,w,h),masked=True,out_dtype="float32")
    data=np.asarray(raw.filled(np.nan),dtype=np.float32)
    x=np.zeros((7,h,w),dtype=np.float32)
    for band,key,out in ((0,"ctx_orthoimage_dn",0),(1,"elevation_m",1),(2,"slope_deg",2),(4,"roughness_rms_m",5),(5,"relief_range_m",6)):
        lo,hi=ranges[key]; v=data[band]; good=np.isfinite(v)
        x[out,good]=np.clip((v[good]-lo)/(hi-lo),0,1)
    a=data[3]; good=np.isfinite(a); rad=np.deg2rad(np.where(good,a,0))
    x[3,good]=np.sin(rad[good]); x[4,good]=np.cos(rad[good])
    return x


class PatchDataset(Dataset):
    def __init__(self, rows, root, ranges, augment=False):
        self.rows,self.root,self.ranges,self.augment=rows,root,ranges,augment
        self.patch_size=int(json.loads((root/"metadata.json").read_text(encoding="utf-8")).get("patch_size_pixels",256))
        self.features=rasterio.open(root/STACK_NAME) # DataLoader uses num_workers=0.
    def __len__(self): return len(self.rows)
    def __getitem__(self,i):
        row=self.rows[i]; h,w=int(row["height"]),int(row["width"])
        x=make_input(self.features,row,self.ranges)
        with Image.open(self.root/row["mask_path"]) as im: y=np.asarray(im,dtype=np.uint8).copy()
        x=np.pad(x,((0,0),(0,max(0,self.patch_size-h)),(0,max(0,self.patch_size-w))))
        y=np.pad(y,((0,max(0,self.patch_size-h)),(0,max(0,self.patch_size-w))),constant_values=IGNORE)
        x,y=torch.from_numpy(x),torch.from_numpy(y.astype(np.int64))
        if self.augment:
            if random.random()<.5:
                x,y=torch.flip(x,(-1,)),torch.flip(y,(-1,)); x[3]=-x[3]
            if random.random()<.5:
                x,y=torch.flip(x,(-2,)),torch.flip(y,(-2,)); x[4]=-x[4]
            if random.random()<.5:
                x,y=x.transpose(-1,-2),y.transpose(-1,-2); east=x[3].clone(); x[3],x[4]=x[4].clone(),east
        return x,y


class Block(nn.Module):
    def __init__(self,ni,no):
        super().__init__(); g=4 if no>=4 else 1
        self.net=nn.Sequential(nn.Conv2d(ni,no,3,padding=1,bias=False),nn.GroupNorm(g,no),nn.ReLU(True),nn.Conv2d(no,no,3,padding=1,bias=False),nn.GroupNorm(g,no),nn.ReLU(True))
    def forward(self,x): return self.net(x)


class SmallUNet(nn.Module):
    def __init__(self):
        super().__init__(); self.e1=Block(7,8); self.e2=Block(8,16); self.e3=Block(16,32); self.mid=Block(32,64); self.pool=nn.MaxPool2d(2)
        self.u3=nn.ConvTranspose2d(64,32,2,2); self.d3=Block(64,32); self.u2=nn.ConvTranspose2d(32,16,2,2); self.d2=Block(32,16); self.u1=nn.ConvTranspose2d(16,8,2,2); self.d1=Block(16,8); self.out=nn.Conv2d(8,CLASSES,1)
    def forward(self,x):
        a=self.e1(x); b=self.e2(self.pool(a)); c=self.e3(self.pool(b)); z=self.mid(self.pool(c))
        z=self.d3(torch.cat((self.u3(z),c),1)); z=self.d2(torch.cat((self.u2(z),b),1)); z=self.d1(torch.cat((self.u1(z),a),1)); return self.out(z)


def class_weights(rows,root):
    counts=np.zeros(CLASSES,dtype=np.int64)
    for row in rows:
        with Image.open(root/row["mask_path"]) as im: y=np.asarray(im,dtype=np.uint8)
        y=y[y<CLASSES]; counts+=np.bincount(y,minlength=CLASSES)[:CLASSES]
    if np.any(counts==0): raise RuntimeError(f"Training split missing classes: {np.flatnonzero(counts==0).tolist()}")
    weights=1/np.power(counts/counts.sum(),.75); weights/=weights.mean()
    print("Train class pixels:",counts.tolist(),"loss weights:",weights.round(3).tolist(),flush=True)
    return torch.tensor(weights,dtype=torch.float32)


def evaluate(model,loader,device):
    confusion=np.zeros((CLASSES,CLASSES),dtype=np.int64); loss_sum=0.; batches=0; criterion=nn.CrossEntropyLoss(ignore_index=IGNORE); model.eval()
    with torch.no_grad():
        for x,y in loader:
            x,y=x.to(device),y.to(device); logits=model(x); loss_sum+=float(criterion(logits,y)); batches+=1; valid=y!=IGNORE
            encoded=(y[valid]*CLASSES+logits.argmax(1)[valid]).cpu().numpy()
            confusion+=np.bincount(encoded,minlength=CLASSES*CLASSES).reshape(CLASSES,CLASSES)
    return confusion,loss_sum/max(1,batches)


def metrics(conf):
    diag=np.diag(conf).astype(float); true=conf.sum(1).astype(float); pred=conf.sum(0).astype(float); union=true+pred-diag
    iou=np.divide(diag,union,out=np.full(CLASSES,np.nan),where=union>0); rec=np.divide(diag,true,out=np.full(CLASSES,np.nan),where=true>0)
    return {"pixel_accuracy_vs_weak_labels":float(diag.sum()/max(1,conf.sum())),"class_iou_vs_weak_labels":{str(i):None if not np.isfinite(iou[i]) else float(iou[i]) for i in range(CLASSES)},"class_recall_vs_weak_labels":{str(i):None if not np.isfinite(rec[i]) else float(rec[i]) for i in range(CLASSES)},"hazard_proxy_recall_vs_weak_labels_classes_1_2":float(diag[1:3].sum()/max(1,true[1:3].sum())),"confusion_matrix_rows_true_cols_predicted":conf.tolist(),"evaluated_pixels":int(conf.sum())}


def predict(model,rows,root,ranges,device):
    stack=root/STACK_NAME; output=root/"jezero_visual_hazard_probability_multimodal_experimental.tif"; qa=root/"prediction_overlays_multimodal"; qa.mkdir(exist_ok=True)
    with rasterio.open(stack) as src:
        profile=src.profile.copy(); profile.update(driver="GTiff",count=4,dtype="float32",nodata=-9999,compress="deflate",predictor=3,tiled=True,blockxsize=256,blockysize=256)
        with rasterio.open(output,"w",**profile) as dst:
            for i,n in enumerate(("p_terrain_not_flagged","p_steep_slope_proxy","p_high_roughness_proxy","p_hazard_proxy_sum_classes_1_2"),1): dst.set_band_description(i,n)
            dst.update_tags(model_status="experimental_multimodal_weak_label_model",input_bands="CTX image, elevation, slope, aspect, roughness, local relief",label_source="weak DTM proxies; not human-verified ground truth")
            dst.write(np.full((4,src.height,src.width),-9999,dtype=np.float32))
            for i,row in enumerate(rows):
                h,w=int(row["height"]),int(row["width"]); x=make_input(src,row,ranges); pad=np.pad(x,((0,0),(0,256-h),(0,256-w)))
                with torch.no_grad(): probs=torch.softmax(model(torch.from_numpy(pad[None]).to(device)),1)[0].cpu().numpy().astype(np.float32)[:,:h,:w]
                with Image.open(root/row["mask_path"]) as im: labels=np.asarray(im,dtype=np.uint8)
                invalid=labels==IGNORE; probs[:,invalid]=-9999.; hazard=probs[1].clip(0)+probs[2].clip(0); hazard[invalid]=-9999.
                win=Window(int(row["col_off"]),int(row["row_off"]),w,h); dst.write(probs,indexes=(1,2,3),window=win); dst.write(hazard,indexes=4,window=win)
                if i<12:
                    gray=np.clip(x[0]*255,0,255).astype(np.uint8); rgb=np.repeat(gray[...,None],3,2).astype(np.float32); steep=probs[1]>=.5; rough=(probs[2]>=.5)&~steep
                    rgb[steep]=.45*rgb[steep]+.55*np.array([235,65,65]); rgb[rough]=.45*rgb[rough]+.55*np.array([255,145,40])
                    Image.fromarray(np.clip(rgb,0,255).astype(np.uint8)).save(qa/f"{row['patch_id']}_prediction.png")
    return output,qa


def main():
    ap=argparse.ArgumentParser(description="Train/evaluate the Jezero multimodal U-Net with weak DTM labels.")
    ap.add_argument("--data",type=Path,default=DEFAULT_DATA); ap.add_argument("--epochs",type=int,default=18); ap.add_argument("--batch-size",type=int,default=4); ap.add_argument("--patience",type=int,default=5); ap.add_argument("--no-predict",action="store_true"); args=ap.parse_args()
    if args.epochs<1 or args.batch_size<1: ap.error("epochs and batch-size must be positive")
    stack=args.data/STACK_NAME; manifest=args.data/"manifest.csv"; meta=args.data/"metadata.json"
    if not stack.is_file() or not manifest.is_file() or not meta.is_file(): raise FileNotFoundError("Run build_jezero_full_features.py and jezero_vision_prototype.py first.")
    random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED); torch.set_num_threads(min(8,max(1,__import__("os").cpu_count() or 1)))
    with manifest.open(newline="",encoding="utf-8-sig") as f: rows=list(csv.DictReader(f))
    for row in rows:
        row["split"]=split_group(row)
        for key in ("image_path","mask_path"):
            if not (args.data/row[key]).is_file(): raise FileNotFoundError(args.data/row[key])
    splits={n:[r for r in rows if r["split"]==n] for n in ("train","validation","test")}
    print("Spatial split:",{n:len(r) for n,r in splits.items()},flush=True)
    if min(map(len,splits.values()))<4: raise RuntimeError("Too few spatial patches; add more labeled coverage.")
    ranges=get_ranges(stack); model_dir=args.data/"model"; model_dir.mkdir(parents=True,exist_ok=True); (model_dir/"multimodal_input_ranges.json").write_text(json.dumps(ranges,indent=2),encoding="utf-8")
    weights=class_weights(splits["train"],args.data); device=torch.device("cuda" if torch.cuda.is_available() else "cpu"); print("device",device,"inputs",ranges["channel_names"],flush=True)
    train=DataLoader(PatchDataset(splits["train"],args.data,ranges,True),batch_size=args.batch_size,shuffle=True,num_workers=0); val=DataLoader(PatchDataset(splits["validation"],args.data,ranges),batch_size=args.batch_size,num_workers=0); test=DataLoader(PatchDataset(splits["test"],args.data,ranges),batch_size=args.batch_size,num_workers=0)
    model=SmallUNet().to(device); criterion=nn.CrossEntropyLoss(weight=weights.to(device),ignore_index=IGNORE); opt=torch.optim.AdamW(model.parameters(),lr=1e-3,weight_decay=1e-4); checkpoint=model_dir/"jezero_multimodal_unet.pt"; best=math.inf; stale=0; history=[]
    for epoch in range(1,args.epochs+1):
        model.train(); total=0.; batches=0
        for x,y in train:
            x,y=x.to(device),y.to(device); opt.zero_grad(set_to_none=True); loss=criterion(model(x),y); loss.backward(); opt.step(); total+=float(loss.detach()); batches+=1
        _,vl=evaluate(model,val,device); tl=total/max(1,batches); history.append({"epoch":epoch,"train_loss":tl,"validation_loss":vl}); print(f"epoch {epoch}/{args.epochs}: train={tl:.4f} val={vl:.4f}",flush=True)
        if vl<best: best=vl; stale=0; torch.save(model.state_dict(),checkpoint)
        else:
            stale+=1
            if stale>=args.patience: print("early stopping",flush=True); break
    model.load_state_dict(torch.load(checkpoint,map_location=device,weights_only=True)); test_conf,test_loss=evaluate(model,test,device); val_conf,_=evaluate(model,val,device)
    report={"status":"experimental_multimodal_weak_label_model","model":"small U-Net, 7 aligned CTX/DTM channels","input_channels":ranges["channel_names"],"classes":{"0":"terrain_not_flagged","1":"steep_slope_proxy","2":"high_roughness_proxy"},"label_source":"weak DTM thresholds; not human-verified visual labels","dune_detection":"not trained: no mapped dune positives in this CTX footprint","route_integration":"optional low-weight A* cost only; not calibrated safety probability","split_patch_counts":{n:len(r) for n,r in splits.items()},"device":str(device),"best_validation_loss_vs_weak_labels":best,"test_loss_vs_weak_labels":test_loss,"validation_metrics_vs_weak_labels":metrics(val_conf),"test_metrics_vs_weak_labels":metrics(test_conf),"limitations":["Several input channels are also used to create the target labels, so high scores mean agreement with proxy rules, not independent vision accuracy.","This model does not validate dune, crater-rim, or wheel-slip detection.","TES/MCD/geology/vector factors remain in the separate approximately 1 km context Parquet; they are not invented as 20 m measurements."],"history":history}
    report_path=model_dir/"multimodal_metrics.json"; report_path.write_text(json.dumps(report,indent=2),encoding="utf-8"); print("checkpoint:",checkpoint,"metrics:",report_path,flush=True); print(json.dumps(report["test_metrics_vs_weak_labels"],indent=2),flush=True)
    if not args.no_predict:
        output,qa=predict(model,rows,args.data,ranges,device); print("probability raster:",output,"previews:",qa,flush=True)
    return 0

if __name__=="__main__":
    try: raise SystemExit(main())
    except Exception as exc: print(f"Jezero multimodal model failed: {exc}",file=sys.stderr); raise
