"""Train a small Jezero U-Net hazard-proxy model from the vision prototype.

Training targets are weak labels derived from DTM thresholds. Metrics therefore
measure agreement with those proxies, not validated rover safety or dune detection.
The generated probability GeoTIFF is experimental and is not connected to A*.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import sys
from pathlib import Path

import numpy as np
import rasterio
import torch
from PIL import Image
from rasterio.windows import Window
from torch import nn
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = ROOT / "data" / "processed" / "vision_prototype" / "jezero_ctx"
IGNORE = 255
CLASS_COUNT = 3  # unflagged, steep-slope proxy, high-roughness proxy; no dune examples exist yet
SEED = 42


class PatchDataset(Dataset):
    def __init__(self, rows: list[dict[str, str]], root: Path, augment: bool = False):
        self.rows = rows
        self.root = root
        self.augment = augment
        metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
        self.patch_size = int(metadata.get("patch_size_pixels", 256))

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int):
        row = self.rows[index]
        with Image.open(self.root / row["image_path"]) as image:
            array = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
        with Image.open(self.root / row["mask_path"]) as mask_image:
            labels = np.asarray(mask_image, dtype=np.uint8).copy()
        pad_h = max(0, self.patch_size - array.shape[0])
        pad_w = max(0, self.patch_size - array.shape[1])
        array = np.pad(array, ((0, pad_h), (0, pad_w)), constant_values=0)
        labels = np.pad(labels, ((0, pad_h), (0, pad_w)), constant_values=IGNORE)
        x = torch.from_numpy(array[None, ...])
        y = torch.from_numpy(labels.astype(np.int64))
        if self.augment:
            if random.random() < 0.5:
                x, y = torch.flip(x, (-1,)), torch.flip(y, (-1,))
            if random.random() < 0.5:
                x, y = torch.flip(x, (-2,)), torch.flip(y, (-2,))
            if random.random() < 0.5:
                x, y = x.transpose(-1, -2), y.transpose(-1, -2)
        return x, y


class ConvBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        groups = 4 if out_channels >= 4 else 1
        self.layers = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, 3, padding=1, bias=False),
            nn.GroupNorm(groups, out_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False),
            nn.GroupNorm(groups, out_channels),
            nn.ReLU(inplace=True),
        )

    def forward(self, x):
        return self.layers(x)


class SmallUNet(nn.Module):
    def __init__(self, classes: int = CLASS_COUNT):
        super().__init__()
        self.enc1 = ConvBlock(1, 8)
        self.enc2 = ConvBlock(8, 16)
        self.enc3 = ConvBlock(16, 32)
        self.center = ConvBlock(32, 64)
        self.pool = nn.MaxPool2d(2)
        self.up3 = nn.ConvTranspose2d(64, 32, 2, stride=2)
        self.dec3 = ConvBlock(64, 32)
        self.up2 = nn.ConvTranspose2d(32, 16, 2, stride=2)
        self.dec2 = ConvBlock(32, 16)
        self.up1 = nn.ConvTranspose2d(16, 8, 2, stride=2)
        self.dec1 = ConvBlock(16, 8)
        self.out = nn.Conv2d(8, classes, 1)

    def forward(self, x):
        a = self.enc1(x)
        b = self.enc2(self.pool(a))
        c = self.enc3(self.pool(b))
        center = self.center(self.pool(c))
        z = self.dec3(torch.cat((self.up3(center), c), dim=1))
        z = self.dec2(torch.cat((self.up2(z), b), dim=1))
        z = self.dec1(torch.cat((self.up1(z), a), dim=1))
        return self.out(z)


def assign_split(row: dict[str, str]) -> str:
    # Keep 2x2 neighboring patches together to reduce spatial leakage.
    group = f"{int(row['row_off']) // 512}:{int(row['col_off']) // 512}".encode("ascii")
    bucket = hashlib.sha1(group).digest()[0] % 10
    return "train" if bucket < 7 else ("validation" if bucket < 9 else "test")


def class_weights(rows: list[dict[str, str]], root: Path) -> torch.Tensor:
    counts = np.zeros(CLASS_COUNT, dtype=np.int64)
    for row in rows:
        with Image.open(root / row["mask_path"]) as im:
            labels = np.asarray(im, dtype=np.uint8)
        valid = labels < CLASS_COUNT
        counts += np.bincount(labels[valid], minlength=CLASS_COUNT)[:CLASS_COUNT]
    if np.any(counts == 0):
        missing = np.flatnonzero(counts == 0).tolist()
        raise RuntimeError(f"Training split has no labeled pixels for classes {missing}; adjust the spatial split or labels.")
    weights = 1.0 / np.power(counts / counts.sum(), 0.75)
    weights /= weights.mean()
    print(f"Training pixel counts by class 0/1/2: {counts.tolist()}; loss weights: {weights.round(3).tolist()}")
    return torch.tensor(weights, dtype=torch.float32)


def confusion_counts(model, loader, device) -> tuple[np.ndarray, float]:
    confusion = np.zeros((CLASS_COUNT, CLASS_COUNT), dtype=np.int64)
    total_loss = 0.0
    batches = 0
    criterion = nn.CrossEntropyLoss(ignore_index=IGNORE)
    model.eval()
    with torch.no_grad():
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            logits = model(x)
            total_loss += float(criterion(logits, y).item())
            batches += 1
            valid = y != IGNORE
            encoded = (y[valid] * CLASS_COUNT + logits.argmax(1)[valid]).cpu().numpy()
            confusion += np.bincount(encoded, minlength=CLASS_COUNT * CLASS_COUNT).reshape(CLASS_COUNT, CLASS_COUNT)
    return confusion, total_loss / max(1, batches)


def metrics_from_confusion(confusion: np.ndarray) -> dict[str, object]:
    diagonal = np.diag(confusion).astype(float)
    true_count = confusion.sum(axis=1).astype(float)
    predicted_count = confusion.sum(axis=0).astype(float)
    union = true_count + predicted_count - diagonal
    iou = np.divide(diagonal, union, out=np.full(CLASS_COUNT, np.nan), where=union > 0)
    recall = np.divide(diagonal, true_count, out=np.full(CLASS_COUNT, np.nan), where=true_count > 0)
    total = max(1, int(confusion.sum()))
    return {
        "pixel_accuracy_vs_weak_labels": float(diagonal.sum() / total),
        "class_iou_vs_weak_labels": {str(i): (None if not np.isfinite(iou[i]) else float(iou[i])) for i in range(CLASS_COUNT)},
        "class_recall_vs_weak_labels": {str(i): (None if not np.isfinite(recall[i]) else float(recall[i])) for i in range(CLASS_COUNT)},
        "hazard_proxy_recall_vs_weak_labels_classes_1_2": float(diagonal[1:3].sum() / max(1.0, true_count[1:3].sum())),
        "confusion_matrix_rows_true_cols_predicted": confusion.tolist(),
        "evaluated_pixels": int(confusion.sum()),
    }


def predict_all(model, rows, root, metadata_path, output_dir, device):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    dem_path = Path(metadata["dem_path"])
    output_path = output_dir / "jezero_visual_hazard_probability_experimental.tif"
    patch_size = int(metadata.get("patch_size_pixels", 256))
    qa_dir = output_dir / "prediction_overlays"
    qa_dir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dem_path) as dem:
        profile = dem.profile.copy()
        profile.update(driver="GTiff", count=4, dtype="float32", nodata=-9999.0,
                       compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256)
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.set_band_description(1, "p_terrain_not_flagged")
            dst.set_band_description(2, "p_steep_slope_proxy")
            dst.set_band_description(3, "p_high_roughness_proxy")
            dst.set_band_description(4, "p_hazard_proxy_sum_classes_1_2")
            dst.update_tags(model_status="experimental_weak_label_model", route_planner_integration="disabled",
                            labels="DTM-derived slope/roughness proxies; not human-verified ground truth")
            # Uncovered / masked cells remain explicit nodata, never an implicit safe value.
            fill = np.full((4, dem.height, dem.width), -9999.0, dtype=np.float32)
            dst.write(fill)
            for i, row in enumerate(rows):
                with Image.open(root / row["image_path"]) as im:
                    gray = np.asarray(im.convert("L"), dtype=np.float32) / 255.0
                height, width = gray.shape
                padded = np.pad(gray, ((0, max(0, patch_size-height)), (0, max(0, patch_size-width))), constant_values=0)
                x = torch.from_numpy(padded[None, None, ...]).to(device)
                with torch.no_grad():
                    probabilities = torch.softmax(model(x), dim=1)[0].cpu().numpy().astype(np.float32)[:, :height, :width]
                labels = np.asarray(Image.open(root / row["mask_path"]), dtype=np.uint8)
                invalid = labels == IGNORE
                probabilities[:, invalid] = -9999.0
                hazard = np.maximum(probabilities[1], 0) + np.maximum(probabilities[2], 0)
                hazard[invalid] = -9999.0
                window = Window(int(row["col_off"]), int(row["row_off"]), int(row["width"]), int(row["height"]))
                dst.write(probabilities, indexes=(1, 2, 3), window=window)
                dst.write(hazard, indexes=4, window=window)
                if i < 12:
                    overlay = np.repeat((gray * 255).astype(np.uint8)[..., None], 3, axis=2)
                    rgb = overlay.astype(np.float32)
                    steep = probabilities[1] >= 0.5
                    rough = (probabilities[2] >= 0.5) & ~steep
                    for selected, color in ((steep, np.array([235, 65, 65])), (rough, np.array([255, 145, 40]))):
                        rgb[selected] = 0.45 * rgb[selected] + 0.55 * color
                    Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB").save(qa_dir / f"{row['patch_id']}_prediction.png")
    return output_path, qa_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and evaluate a small Jezero U-Net hazard-proxy model.")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA, help="Vision prototype directory containing manifest.csv and metadata.json.")
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--no-predict", action="store_true", help="Train/evaluate only; skip full-scene hazard GeoTIFF inference.")
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive")
    manifest_path = args.data / "manifest.csv"
    metadata_path = args.data / "metadata.json"
    if not manifest_path.is_file() or not metadata_path.is_file():
        raise FileNotFoundError(f"Vision prototype is incomplete: {args.data}")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    torch.set_num_threads(min(8, max(1, __import__("os").cpu_count() or 1)))

    with manifest_path.open(newline="", encoding="utf-8-sig") as stream:
        rows = list(csv.DictReader(stream))
    for row in rows:
        row["split"] = assign_split(row)
        for key in ("image_path", "mask_path"):
            if not (args.data / row[key]).is_file():
                raise FileNotFoundError(args.data / row[key])
    splits = {name: [row for row in rows if row["split"] == name] for name in ("train", "validation", "test")}
    print("Spatially grouped patch split:", {name: len(part) for name, part in splits.items()})
    if min(len(splits[name]) for name in ("train", "validation", "test")) < 4:
        raise RuntimeError("Too few patches in a spatial split; the prototype needs more coverage before training.")
    if any("3" in np.unique(np.asarray(Image.open(args.data / row["mask_path"]), dtype=np.uint8)).astype(str) for row in rows):
        print("Note: mapped dune labels exist, but this prototype trains only the three currently observed classes.")
    weights = class_weights(splits["train"], args.data)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Training device: {device}; torch {torch.__version__}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    train_loader = DataLoader(PatchDataset(splits["train"], args.data, augment=True), batch_size=args.batch_size, shuffle=True, num_workers=0)
    validation_loader = DataLoader(PatchDataset(splits["validation"], args.data), batch_size=args.batch_size, shuffle=False, num_workers=0)
    test_loader = DataLoader(PatchDataset(splits["test"], args.data), batch_size=args.batch_size, shuffle=False, num_workers=0)
    model = SmallUNet().to(device)
    criterion = nn.CrossEntropyLoss(weight=weights.to(device), ignore_index=IGNORE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    model_dir = args.data / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = model_dir / "jezero_small_unet.pt"
    best_loss = math.inf
    stale = 0
    history = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        train_loss = 0.0
        batches = 0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(x), y)
            loss.backward()
            optimizer.step()
            train_loss += float(loss.item())
            batches += 1
        _, val_loss = confusion_counts(model, validation_loader, device)
        train_loss /= max(1, batches)
        history.append({"epoch": epoch, "train_loss": train_loss, "validation_loss": val_loss})
        print(f"Epoch {epoch:02d}/{args.epochs}: train_loss={train_loss:.4f}, val_loss={val_loss:.4f}", flush=True)
        if val_loss < best_loss:
            best_loss = val_loss
            stale = 0
            torch.save(model.state_dict(), checkpoint)
        else:
            stale += 1
            if stale >= args.patience:
                print("Early stopping: validation loss did not improve.")
                break

    model.load_state_dict(torch.load(checkpoint, map_location=device, weights_only=True))
    test_confusion, test_loss = confusion_counts(model, test_loader, device)
    validation_confusion, _ = confusion_counts(model, validation_loader, device)
    report = {
        "status": "experimental_weak_label_model",
        "model": "small U-Net, grayscale CTX input, 3 output classes",
        "class_ids": {"0": "terrain_not_flagged", "1": "steep_slope_proxy", "2": "high_roughness_proxy"},
        "training_labels": "weak labels generated from DTM thresholds; not human-verified visual ground truth",
        "dune_detection": "not trained: there are zero mapped dune polygons in the Jezero CTX DTM footprint",
        "route_planner_integration": "disabled; do not treat predictions as validated hazards or safety scores",
        "split_method": "neighboring 2x2 patches kept in the same deterministic spatial group",
        "split_patch_counts": {name: len(part) for name, part in splits.items()},
        "device": str(device),
        "best_validation_loss_vs_weak_labels": best_loss,
        "test_loss_vs_weak_labels": test_loss,
        "validation_metrics_vs_weak_labels": metrics_from_confusion(validation_confusion),
        "test_metrics_vs_weak_labels": metrics_from_confusion(test_confusion),
        "history": history,
    }
    metrics_path = model_dir / "metrics.json"
    metrics_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Saved model: {checkpoint}")
    print(f"Saved weak-label evaluation: {metrics_path}")
    print(json.dumps(report["test_metrics_vs_weak_labels"], indent=2))
    if not args.no_predict:
        output_path, qa_dir = predict_all(model, rows, args.data, metadata_path, args.data, device)
        print(f"Saved experimental per-pixel hazard probabilities: {output_path}")
        print(f"Saved prediction previews: {qa_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Jezero model training failed: {exc}", file=sys.stderr)
        raise



