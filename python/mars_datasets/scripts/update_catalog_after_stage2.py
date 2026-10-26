import csv
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
p=ROOT/'data'/'catalog'/'factor_registry.csv'
updates={
'elevation_m':('processed_global_1km','Global 1 km DEM at data/processed/rasters/global/mola_hrsc_blend_dem_1km.tif'),
'slope_deg':('processed_global_1km','Central-difference slope degrees at data/processed/rasters/global/mola_hrsc_blend_slope_deg_1km.tif'),
'aspect_deg':('pending','Can derive from DEM later; flat-cell direction remains undefined.'),
'roughness_m':('pending','Scale-dependent window statistic not yet generated.'),
'crater_diameter_km':('csv_prepared','384,343 Robbins crater records in data/processed/vectors/robbins_craters.csv'),
'crater_distance_km':('pending','Compute from crater centers and diameter/buffer when building a regional route grid.'),
'geology_unit':('routing_geopackage_ready','Selected 1,311 global geology polygons in routing_layers.gpkg; source Mars CRS retained.'),
'dune_presence':('routing_geopackage_ready_regional','Equatorial 547, north polar 316, south polar 746 dune polygons; mapped-product coverage only.'),
'dune_distance_km':('pending','Compute regionally from indexed dune polygons; absence outside mapped footprints means unknown.'),
'thermal_inertia':('raw_native_decode_pending','VICAR and binary files retained; decoding awaits documented layout, units, and projection.'),
'ice_consistency':('not_downloaded','SWIM official server timed out; no numerical SWIM layer available.'),
'air_temperature':('mcd_extracted_schema_indexed','MCD 6.2 extracted; 82 NetCDF files and variable catalog indexed. Scenario-aware query interface still pending.'),
'air_pressure':('mcd_extracted_schema_indexed','MCD 6.2 extracted; preserve scenario, altitude, season, and local time.'),
'wind_speed':('mcd_extracted_schema_indexed','MCD 6.2 extracted; derive magnitude from documented wind components and level.'),
'radiation_dose':('no_global_numeric_layer','Curiosity RAD sample is local to Gale; Odyssey JPEG is visual only.'),
'terrain_class_probabilities':('ai4mars_pairs_prepared','44,572 confirmed image-mask pairs across separate label tasks; do not combine task label codes.'),
'energy_cost':('blocked_profile_nulls','Requires validated rover/crew mass, drivetrain, speed, and energy model coefficients.'),
'slip_risk':('not_calibrated','AI4Mars image classes and thermal inertia are not measured wheel-slip labels; requires calibrated terramechanics/telemetry.'),
}
with p.open(newline='',encoding='utf-8-sig') as f:
    reader=csv.DictReader(f); fields=reader.fieldnames; rows=list(reader)
for row in rows:
    if row['factor_id'] in updates:
        row['status'],row['preprocessing']=updates[row['factor_id']]
tmp=p.with_suffix('.csv.tmp')
with tmp.open('w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)
tmp.replace(p)
m=ROOT/'data'/'catalog'/'dataset_manifest.csv'
with m.open(newline='',encoding='utf-8-sig') as f:
    reader=csv.DictReader(f); fields=reader.fieldnames; rows=list(reader)
for row in rows:
    if row['dataset_id']=='mars_climate_database':
        row['status']='downloaded_extracted_indexed'
        row['notes']='MCD 6.2 extracted to data/processed/climate/mcd_6.2_bundle; 82 NetCDF files and 1,407 data variables indexed. Runtime query interface still pending.'
tmp=m.with_suffix('.csv.tmp')
with tmp.open('w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)
tmp.replace(m)
