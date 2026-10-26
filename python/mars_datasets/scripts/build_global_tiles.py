from __future__ import annotations
import argparse, csv, json, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
PROC = ROOT / "data" / "processed"
TILE_ROOT = PROC / "feature_store" / "global_tiles" / "10deg"
BUILDER = SCRIPTS / "build_route_grid.py"
LAT_STEP = LON_STEP = 10
LS_DEG = 150.0
LOCAL_TIME_HOURS = 13.25
MCD_SCENARIO = "clim_aveEUV"


def tile_id(west: int, south: int) -> str:
    return f"tile_10deg_w{west}_s{south}"


def tile_plan():
    for south in range(-90, 90, LAT_STEP):
        for west in range(-180, 180, LON_STEP):
            yield {"tile_id": tile_id(west, south), "west": west, "south": south,
                   "east": west + LON_STEP, "north": south + LAT_STEP}


def write_catalog(rows, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fields = ["tile_id", "west", "south", "east", "north", "status", "parquet_path",
              "manifest_path", "rows", "bytes", "updated_utc", "message"]
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(path)


def prepare_sources():
    print("Preparing required global source layers; AI4Mars/MEDA are omitted because they are not spatially registered per terrain cell.", flush=True)
    sys.path.insert(0, str(SCRIPTS))
    import preprocess_stage1 as stage1
    import preprocess_stage2 as stage2
    stage1.convert_robbins()
    stage1.write_factor_registry()
    stage1.extract_mcd()
    stage2.index_climate()
    stage2.extract_vectors()
    stage2.build_routing_gpkg()
    dem = stage2.make_1km_dem()
    stage2.make_slope(dem)
    tes_paths = [PROC / "rasters" / "global" / f"tes_thermal_inertia_{x}_20ppd.tif" for x in ("day", "night")]
    if not all(p.is_file() for p in tes_paths):
        subprocess.run([sys.executable, str(SCRIPTS / "preprocess_tes_archive.py")], cwd=ROOT, check=True)
    required = [dem, dem.with_name("mola_hrsc_blend_slope_deg_1km.tif"),
                PROC / "vectors" / "routing_layers.gpkg", PROC / "vectors" / "robbins_craters.csv",
                *tes_paths]
    missing = [str(p) for p in required if not p.is_file()]
    if missing:
        raise FileNotFoundError("Required global layers were not prepared: " + ", ".join(missing))
    print("Required global layers are ready.", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Build a resumable 10-degree Parquet tile set across Mars.")
    ap.add_argument("--start-index", type=int, default=0, help="Zero-based tile index in south-to-north, west-to-east order.")
    ap.add_argument("--limit", type=int, help="Build at most this many tiles; omit to continue through the whole planet.")
    ap.add_argument("--skip-preprocess", action="store_true", help="Use already-prepared source layers.")
    args = ap.parse_args()
    plan = list(tile_plan())
    if not 0 <= args.start_index < len(plan):
        ap.error(f"--start-index must be in 0..{len(plan)-1}")
    selected = plan[args.start_index: args.start_index + args.limit if args.limit else None]
    if args.limit is not None and args.limit < 1:
        ap.error("--limit must be positive")
    TILE_ROOT.mkdir(parents=True, exist_ok=True)
    catalog = TILE_ROOT.parent / "tiles_catalog.csv"
    rows = []
    for i, t in enumerate(plan):
        out = TILE_ROOT / f"{t['tile_id']}.parquet"
        manifest = out.with_suffix(".manifest.json")
        complete = out.is_file() and manifest.is_file()
        rows.append({**t, "status": "complete" if complete else "planned",
                     "parquet_path": str(out.relative_to(ROOT)),
                     "manifest_path": str(manifest.relative_to(ROOT)),
                     "rows": "", "bytes": out.stat().st_size if complete else "",
                     "updated_utc": "", "message": "already present" if complete else ""})
    write_catalog(rows, catalog)
    disk = shutil.disk_usage(ROOT)
    rough_tile_budget = len(selected) * 60_000_000
    if not args.skip_preprocess:
        # Reserve room for MCD extraction and the global rasters/vectors as well as future tiles.
        if disk.free < rough_tile_budget + 20_000_000_000:
            raise OSError(f"Free space {disk.free/1e9:.1f} GB is below the conservative space budget for this run.")
        prepare_sources()
    else:
        print("Using existing prepared source layers.", flush=True)
    for offset, t in enumerate(selected, start=args.start_index):
        idx = next(i for i, x in enumerate(rows) if x["tile_id"] == t["tile_id"])
        out = TILE_ROOT / f"{t['tile_id']}.parquet"
        manifest = out.with_suffix(".manifest.json")
        if out.is_file() and manifest.is_file():
            print(f"[{offset+1}/{len(plan)}] Already complete: {t['tile_id']}", flush=True)
            rows[idx]["status"] = "complete"
            continue
        rows[idx].update(status="building", updated_utc=datetime.now(timezone.utc).isoformat(), message="")
        write_catalog(rows, catalog)
        print(f"[{offset+1}/{len(plan)}] Building {t['tile_id']} bounds=({t['west']},{t['south']},{t['east']},{t['north']})", flush=True)
        cmd = [sys.executable, str(BUILDER), "--bounds", str(t["west"]), str(t["south"]),
               str(t["east"]), str(t["north"]), "--ls", str(LS_DEG), "--local-time",
               str(LOCAL_TIME_HOURS), "--mcd-scenario", MCD_SCENARIO, "--output", str(out), "--no-csv"]
        started = time.time()
        try:
            result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            if result.stdout:
                print(result.stdout, end="", flush=True)
            if result.stderr:
                print(result.stderr, end="", file=sys.stderr, flush=True)
            if result.returncode != 0:
                raise subprocess.CalledProcessError(result.returncode, cmd, result.stdout, result.stderr)
            meta = json.loads(manifest.read_text(encoding="utf-8"))
            rows[idx].update(status="complete", rows=meta.get("cells", ""), bytes=out.stat().st_size,
                             updated_utc=datetime.now(timezone.utc).isoformat(),
                             message=f"elapsed_seconds={time.time()-started:.1f}")
            write_catalog(rows, catalog)
            print(f"Completed {t['tile_id']}: {meta.get('cells', 0):,} cells, {out.stat().st_size/1e6:.1f} MB", flush=True)
        except Exception as exc:
            rows[idx].update(status="failed", updated_utc=datetime.now(timezone.utc).isoformat(), message=str(exc)[:500])
            write_catalog(rows, catalog)
            print(f"FAILED {t['tile_id']}: {exc}; continuing to next tile", file=sys.stderr, flush=True)
            continue
    complete = sum(r["status"] == "complete" for r in rows)
    print(f"Tile batch ended. Catalog: {catalog}; complete tiles: {complete}/{len(plan)}", flush=True)

if __name__ == "__main__":
    main()
