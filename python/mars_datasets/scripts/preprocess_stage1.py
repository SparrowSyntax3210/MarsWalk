from __future__ import annotations
import csv
import json
import os
import shutil
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw'
PROCESSED = ROOT / 'data' / 'processed'
CATALOG = ROOT / 'data' / 'catalog'


def log_entry(step: str, status: str, input_path: str, output_path: str, note: str) -> None:
    path = CATALOG / 'preprocessing_log.csv'
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists()
    with path.open('a', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        if not exists:
            w.writerow(['timestamp_utc','step','status','input_path','output_path','notes'])
        w.writerow([datetime.now(timezone.utc).isoformat(timespec='seconds'), step, status, input_path, output_path, note])


def convert_robbins() -> None:
    source = RAW / 'craters' / 'robbins_craters.geojson'
    outdir = PROCESSED / 'vectors'
    outdir.mkdir(parents=True, exist_ok=True)
    target = outdir / 'robbins_craters.csv'
    metadata = outdir / 'robbins_craters_metadata.json'
    if not source.is_file():
        raise FileNotFoundError(source)
    text = source.read_text(encoding='utf-8')
    decoder = json.JSONDecoder()
    keypos = text.find('"features"')
    if keypos < 0:
        raise ValueError('GeoJSON has no features member')
    i = text.find(':', keypos) + 1
    while i < len(text) and text[i].isspace(): i += 1
    if i >= len(text) or text[i] != '[':
        raise ValueError('GeoJSON features is not an array')
    i += 1
    count = 0
    min_lat = min_lon = float('inf')
    max_lat = max_lon = float('-inf')
    temp = target.with_suffix('.csv.tmp')
    with temp.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['crater_id','longitude_east_deg','latitude_deg','diameter_km'])
        while i < len(text):
            while i < len(text) and (text[i].isspace() or text[i] == ','): i += 1
            if i < len(text) and text[i] == ']': break
            feature, end = decoder.raw_decode(text, i)
            i = end
            props = feature.get('properties') or {}
            geom = feature.get('geometry') or {}
            coords = geom.get('coordinates') or []
            if len(coords) >= 2:
                lon = props.get('lon_e', coords[0])
                lat = props.get('lat', coords[1])
                diameter = props.get('diamkm')
                if lon is not None and lat is not None:
                    w.writerow([props.get('craterid'), lon, lat, diameter])
                    lon_f, lat_f = float(lon), float(lat)
                    min_lon, max_lon = min(min_lon, lon_f), max(max_lon, lon_f)
                    min_lat, max_lat = min(min_lat, lat_f), max(max_lat, lat_f)
                    count += 1
    temp.replace(target)
    meta = {
        'source_file': str(source.relative_to(ROOT)).replace('\\','/'),
        'output_file': str(target.relative_to(ROOT)).replace('\\','/'),
        'feature_count': count,
        'geometry_type': 'Point',
        'coordinate_columns': {'longitude_east_deg':'degrees east, as supplied','latitude_deg':'degrees north, as supplied'},
        'properties': {'crater_id':'crater identifier','diameter_km':'diameter in km as supplied'},
        'bbox_lon_lat': [min_lon, min_lat, max_lon, max_lat] if count else None,
        'crs': 'Source GeoJSON coordinate reference not inferred here; verify source metadata before spatial overlay.',
        'processing': 'Flattened point coordinates and selected source properties. Raw GeoJSON retained unchanged. No imputed rim heights or hazard labels.'
    }
    metadata.write_text(json.dumps(meta, indent=2), encoding='utf-8')
    if count == 0:
        raise ValueError('No crater records were written')
    log_entry('robbins_geojson_to_csv','complete',str(source.relative_to(ROOT)),str(target.relative_to(ROOT)),f'{count} point records; source coordinates/diameters retained; no derived terrain values.')
    print(f'Robbins CSV: {target} ({count:,} rows; {target.stat().st_size:,} bytes)')


def extract_mcd() -> None:
    source = RAW / 'climate' / 'MCD_6.2.tar.gz'
    outbase = PROCESSED / 'climate'
    target = outbase / 'mcd_6.2_bundle'
    stage = outbase / '.mcd_6.2_extracting'
    if not source.is_file():
        raise FileNotFoundError(source)
    outbase.mkdir(parents=True, exist_ok=True)
    if target.exists():
        print(f'MCD extraction already exists; leaving untouched: {target}')
        return
    if stage.exists():
        raise RuntimeError(f'Partial extraction exists at {stage}; inspect it before retrying.')
    stage.mkdir()
    count = total = 0
    try:
        with tarfile.open(source, 'r:gz') as archive:
            for member in archive:
                if member.name.startswith('/') or '..' in Path(member.name).parts:
                    raise ValueError(f'Unsafe archive path: {member.name}')
                if member.issym() or member.islnk() or member.isdev():
                    raise ValueError(f'Unsupported link/device in archive: {member.name}')
                archive.extract(member, path=stage, filter='data')
                count += 1
                total += member.size
                if count % 20 == 0:
                    print(f'MCD extraction: {count} entries, {total/1e9:.2f} GB expanded', flush=True)
        stage.rename(target)
    except Exception:
        print(f'Extraction stopped. Partial files retained for inspection at: {stage}')
        raise
    log_entry('mcd_6_2_extract','complete',str(source.relative_to(ROOT)),str(target.relative_to(ROOT)),f'{count} entries; {total:,} expanded bytes; raw tar.gz preserved.')
    print(f'MCD extracted: {target} ({count} entries; {total:,} expanded bytes)')


def write_factor_registry() -> None:
    path = CATALOG / 'factor_registry.csv'
    rows = [
        ['elevation_m','surface elevation','m','raster','hrsc_mola_dem','Read DEM metadata; align to planning grid','available_raw','source metadata/vertical datum pending'],
        ['slope_deg','terrain slope','degree','derived_raster','hrsc_mola_dem','Derive from DEM with geodesic/map-aware gradient','not_preprocessed','resolution and algorithm affect result'],
        ['aspect_deg','terrain aspect','degree','derived_raster','hrsc_mola_dem','Derive from DEM; mark flat cells separately','not_preprocessed','aspect undefined on flat cells'],
        ['roughness_m','local terrain roughness','m','derived_raster','hrsc_mola_dem','Windowed elevation range/standard deviation at stated scale','not_preprocessed','scale dependent'],
        ['crater_diameter_km','crater diameter','km','vector_attribute','robbins_craters','Use source property; output CSV prepared','raw_and_csv_prepared','catalogue completeness and uncertainty from source'],
        ['crater_distance_km','distance to crater feature','km','derived_raster','robbins_craters','Spatial index then nearest-feature distance/buffer','not_preprocessed','point-center distance is not rim distance'],
        ['geology_unit','mapped geologic unit','category','vector/raster','sim3292_geology','Extract authoritative GIS layer; reproject and rasterize IDs','raw_archive_only','unit scale and map uncertainty'],
        ['dune_presence','mapped dune area membership','boolean/category','vector/raster','mgd3_dunes','Extract regional GIS; validate coverage; rasterize footprints','raw_archives_only','absence outside mapped coverage is unknown'],
        ['dune_distance_km','distance to mapped dunes','km','derived_raster','mgd3_dunes','Spatial index then distance transform','not_preprocessed','coverage varies by product'],
        ['thermal_inertia','surface thermal inertia','product units','raster','tes_thermal_inertia','Decode native labels/layout; convert and align','raw_native_format','coarse proxy, not direct traction'],
        ['ice_consistency','subsurface ice consistency','index','raster','swim_ice_products','Acquire SWIM product; retain footprint/nodata','not_downloaded','not a direct ice truth; regional coverage'],
        ['air_temperature','atmospheric temperature','K','model_grid/query','mars_climate_database','Use MCD package/interface and cache by location/season/local time','mcd_archive_downloaded_not_extracted','modelled climatology/scenario dependent'],
        ['air_pressure','surface/atmospheric pressure','Pa','model_grid/query','mars_climate_database','Use MCD interface; preserve altitude and scenario','mcd_archive_downloaded_not_extracted','modelled; height datum matters'],
        ['wind_speed','near-surface wind','m/s','model_grid/query','mars_climate_database','Use MCD wind components; derive magnitude only with documented level','mcd_archive_downloaded_not_extracted','modelled, not a real-time forecast'],
        ['radiation_dose','surface radiation dose','mSv or source units','observation/model','msl_rad_sample; mars_odyssey_visual','Need numeric calibrated spatial product/model; rover sample not global','not_available_as_numeric_global_layer','do not derive numeric values from JPEG colors'],
        ['terrain_class_probabilities','image-derived terrain classes','probability','model_output','ai4mars_merged','Train segmentation model on matched images/masks','not_preprocessed','rover imagery domain; generalization limited'],
        ['energy_cost','vehicle energy per cell','Wh','derived_cost','vehicle_profile','Physics/engineering model calibrated to vehicle','blocked_profile_nulls','requires validated vehicle parameters'],
        ['slip_risk','wheel slip risk','probability or percent','derived/model','ai4mars_merged; surface proxies','Calibrated terramechanics model or labeled wheel/drive telemetry','not_available_as_validated_model','thermal inertia/class labels alone do not provide slip truth'],
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['factor_id','factor_name','unit','factor_type','source_dataset','preprocessing','status','uncertainty'])
        w.writerows(rows)
    print(f'Factor registry populated: {path} ({len(rows)} factors)')


if __name__ == '__main__':
    convert_robbins()
    write_factor_registry()
    extract_mcd()
