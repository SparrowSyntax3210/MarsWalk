from __future__ import annotations
import argparse, csv, json, math, os, re, zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject
from rasterio.windows import Window
import netCDF4
import pyogrio

ROOT=Path(__file__).resolve().parent.parent
RAW=ROOT/'data'/'raw'; PROC=ROOT/'data'/'processed'; CATALOG=ROOT/'data'/'catalog'
MARS_RADIUS_M=3_389_500.0

def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp')
    with tmp.open('w',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore'); w.writeheader(); w.writerows(rows)
    tmp.replace(path)

def log(step,status,input_path,output_path,note):
    p=CATALOG/'preprocessing_log.csv'; p.parent.mkdir(parents=True,exist_ok=True)
    new=not p.exists()
    with p.open('a',newline='',encoding='utf-8') as f:
        w=csv.writer(f)
        if new: w.writerow(['timestamp_utc','step','status','input_path','output_path','notes'])
        w.writerow([datetime.now(timezone.utc).isoformat(timespec='seconds'),step,status,str(input_path),str(output_path),note])

def make_1km_dem():
    src_path=next((RAW/'dem').glob('Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'))
    outdir=PROC/'rasters'/'global'; outdir.mkdir(parents=True,exist_ok=True)
    dst_path=outdir/'mola_hrsc_blend_dem_1km.tif'
    if dst_path.exists():
        print('1 km DEM exists; skipping warp:',dst_path); return dst_path
    with rasterio.open(src_path) as src:
        factor=5
        width=math.ceil(src.width/factor); height=math.ceil(src.height/factor)
        transform=src.transform* rasterio.Affine.scale(src.width/width,src.height/height)
        profile=src.profile.copy(); profile.update(width=width,height=height,transform=transform,
            compress='deflate',predictor=2,tiled=True,blockxsize=512,blockysize=512,
            BIGTIFF='IF_SAFER',num_threads='ALL_CPUS')
        tmp=dst_path.with_suffix('.tif.tmp')
        profile['driver']='GTiff'
        with rasterio.open(tmp,'w',**profile) as dst:
            reproject(source=rasterio.band(src,1),destination=rasterio.band(dst,1),
                src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,
                dst_transform=transform,dst_crs=src.crs,dst_nodata=src.nodata,
                resampling=Resampling.average,num_threads=4,warp_mem_limit=512)
            dst.update_tags(product='MOLA/HRSC blended DEM averaged to nominal 1 km cells',
                source=str(src_path),method='area average within source CRS; no datum reprojection',
                caution='Nominal 1 km at equator; longitudinal cell ground width shrinks with latitude.')
        tmp.replace(dst_path)
    log('global_dem_1km','complete',src_path,dst_path,'Average-resampled from 200 m source in native Mars geographic CRS; about 1 km at equator.')
    print('Created',dst_path)
    return dst_path

def make_slope(dem_path):
    out=dem_path.with_name('mola_hrsc_blend_slope_deg_1km.tif')
    if out.exists(): print('Slope exists; skipping:',out); return out
    with rasterio.open(dem_path) as src:
        nodata=-9999.0; profile=src.profile.copy()
        profile.update(dtype='float32',nodata=nodata,compress='deflate',predictor=3,tiled=True,
            blockxsize=512,blockysize=512,BIGTIFF='IF_SAFER',num_threads='ALL_CPUS')
        tmp=out.with_suffix('.tif.tmp'); a=abs(src.transform.a); e=abs(src.transform.e)
        xdeg=a*math.pi/180*MARS_RADIUS_M; y_m=e*math.pi/180*MARS_RADIUS_M
        with rasterio.open(tmp,'w',**profile) as dst:
            for _, win in src.block_windows(1):
                r0=int(win.row_off); c0=int(win.col_off); hh=int(win.height); ww=int(win.width)
                rr0=max(0,r0-1); cc0=max(0,c0-1); rr1=min(src.height,r0+hh+1); cc1=min(src.width,c0+ww+1)
                arr=src.read(1,window=Window(cc0,rr0,cc1-cc0,rr1-rr0)).astype('float32')
                ys=np.arange(r0,r0+hh); xs=np.arange(c0,c0+ww)
                cy=ys-rr0; cx=xs-cc0
                left=np.maximum(cx-1,0); right=np.minimum(cx+1,arr.shape[1]-1)
                up=np.maximum(cy-1,0); down=np.minimum(cy+1,arr.shape[0]-1)
                center=arr[np.ix_(cy,cx)]; west=arr[np.ix_(cy,left)]; east=arr[np.ix_(cy,right)]
                north=arr[np.ix_(up,cx)]; south=arr[np.ix_(down,cx)]
                lat=src.transform.f+(ys+0.5)*src.transform.e
                dx_m=np.maximum(xdeg*np.cos(np.deg2rad(lat)),1e-3)[:,None]*(right-left)[None,:]
                dy_m=np.maximum(y_m,1e-3)*(down-up)[:,None]
                dx=(east-west)/dx_m; dy=(south-north)/dy_m
                valid=(center!=src.nodata)&(west!=src.nodata)&(east!=src.nodata)&(north!=src.nodata)&(south!=src.nodata)
                sl=np.full(center.shape,nodata,dtype='float32')
                sl[valid]=(np.degrees(np.arctan(np.hypot(dx[valid],dy[valid])))).astype('float32')
                dst.write(sl,1,window=win)
            dst.update_tags(product='Terrain slope in degrees, Horn-like central differences',
                source=str(dem_path),mars_radius_m=str(MARS_RADIUS_M),
                caution='Derived from nominal 1 km DEM; polar longitude scaling is handled by cosine(latitude).')
        tmp.replace(out)
    log('global_slope_1km','complete',dem_path,out,'Central-difference slope in degrees from 1 km DEM; Mars radius 3,389,500 m.')
    print('Created',out)
    return out

def index_climate():
    base=PROC/'climate'/'mcd_6.2_bundle'/'MCD_6.2'/'data'
    files=sorted(base.rglob('*.nc'))
    file_rows=[]; var_rows=[]
    for p in files:
        rel=p.relative_to(ROOT)
        try:
            with netCDF4.Dataset(p) as ds:
                dims=';'.join(f'{k}={len(v)}' for k,v in ds.dimensions.items())
                names=[]
                for name,var in ds.variables.items():
                    names.append(name)
                    if name in ds.dimensions: continue
                    attrs={a:getattr(var,a,'') for a in ('long_name','units','standard_name')}
                    var_rows.append({'file':str(rel),'variable':name,'dimensions':','.join(var.dimensions),
                        'shape':'x'.join(map(str,var.shape)),'dtype':str(var.dtype),
                        'long_name':str(attrs['long_name'])[:300],'units':str(attrs['units'])[:100],
                        'standard_name':str(attrs['standard_name'])[:100]})
                file_rows.append({'file':str(rel),'size_bytes':p.stat().st_size,'dimensions':dims,
                    'variables':'|'.join(names),'status':'indexed'})
        except Exception as e:
            file_rows.append({'file':str(rel),'size_bytes':p.stat().st_size,'status':'error: '+repr(e)})
    write_csv(PROC/'climate'/'mcd_netcdf_files.csv',['file','size_bytes','dimensions','variables','status'],file_rows)
    write_csv(PROC/'climate'/'mcd_variable_catalog.csv',['file','variable','dimensions','shape','dtype','long_name','units','standard_name'],var_rows)
    log('mcd_netcdf_metadata_index','complete',base,PROC/'climate'/'mcd_variable_catalog.csv',f'Indexed {len(files)} NetCDF files and {len(var_rows)} data variables; values not expanded into CSV.')
    print(f'Indexed {len(files)} MCD NetCDF files and {len(var_rows)} variables')

def selected_members(z):
    infos=z.infolist(); shp_stems=set(); gdb_prefixes=set()
    for i in infos:
        name=i.filename.replace('\\','/'); parts=name.split('/')
        if Path(name).suffix.lower()=='.shp': shp_stems.add(name[:-4].lower())
        for j,part in enumerate(parts):
            if part.lower().endswith('.gdb'):
                gdb_prefixes.add('/'.join(parts[:j+1]).lower())
    sidecars={'.shp','.shx','.dbf','.prj','.cpg','.sbn','.sbx','.shp.xml','.shp.aux.xml'}
    chosen=[]
    for i in infos:
        name=i.filename.replace('\\','/'); low=name.lower(); p=Path(name); suffix=p.suffix.lower()
        if i.is_dir(): continue
        if any(low.startswith(prefix+'/') for prefix in gdb_prefixes): chosen.append(i); continue
        if any(p.with_suffix('').as_posix().lower()==stem and suffix in sidecars for stem in shp_stems): chosen.append(i); continue
        if low.endswith('.shp.xml') and low[:-9] in shp_stems: chosen.append(i)
    return chosen

def extract_vectors():
    archives=[('geology',RAW/'geology'/'sim3292_database.zip'),
      ('equatorial_dunes',RAW/'dunes'/'equatorial'/'mgd3_equatorial_shapefiles.zip'),
      ('north_polar_dunes',RAW/'dunes'/'north_polar'/'mgd3_north_polar_dvd.zip'),
      ('south_polar_dunes',RAW/'dunes'/'south_polar'/'mgd3_south_polar_gis.zip')]
    base=PROC/'vectors'/'source_layers'; base.mkdir(parents=True,exist_ok=True)
    all_rows=[]
    for name,archive in archives:
        if not archive.exists(): print('Missing archive, skip',archive); continue
        dest=base/name
        marker=dest/'.extraction_complete.json'
        if not marker.exists():
            tmp=base/(name+'.extracting')
            if tmp.exists(): raise RuntimeError(f'Incomplete staging extraction exists: {tmp}; inspect before rerun.')
            tmp.mkdir(parents=True)
            with zipfile.ZipFile(archive) as z:
                members=selected_members(z); total=sum(x.file_size for x in members)
                print(f'Extracting {name}: {len(members)} vector files, {total/1e9:.2f} GB')
                for info in members:
                    member=info.filename.replace('\\','/')
                    if member.startswith('/') or '..' in Path(member).parts: raise ValueError('Unsafe archive path '+member)
                    target=(tmp/member).resolve()
                    if tmp.resolve() not in target.parents: raise ValueError('Archive path escaped staging')
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with z.open(info) as src, target.open('wb') as dst:
                        while True:
                            chunk=src.read(1024*1024)
                            if not chunk: break
                            dst.write(chunk)
            tmp.rename(dest)
            marker.write_text(json.dumps({'archive':str(archive),'selected_files':len(members),'expanded_bytes':total},indent=2),encoding='utf-8')
        else: print('Vector extraction already complete:',name)
        for shp in dest.rglob('*.shp'):
            try:
                info=pyogrio.read_info(shp)
                all_rows.append({'dataset':name,'layer_path':str(shp.relative_to(ROOT)),
                    'layer_name':shp.stem,'feature_count':info.get('features'),
                    'geometry_type':info.get('geometry_type'),'crs':info.get('crs'),
                    'fields':'|'.join(info.get('fields',[])),'status':'indexed'})
            except Exception as e:
                all_rows.append({'dataset':name,'layer_path':str(shp.relative_to(ROOT)),
                    'layer_name':shp.stem,'status':'index_error: '+repr(e)})
        for gdb in dest.rglob('*.gdb'):
            try:
                for layer,geom in pyogrio.list_layers(gdb):
                    info=pyogrio.read_info(gdb,layer=layer)
                    all_rows.append({'dataset':name,'layer_path':str(gdb.relative_to(ROOT)),
                        'layer_name':str(layer),'feature_count':info.get('features'),
                        'geometry_type':geom,'crs':info.get('crs'),
                        'fields':'|'.join(info.get('fields',[])),'status':'indexed_gdb'})
            except Exception as e:
                all_rows.append({'dataset':name,'layer_path':str(gdb.relative_to(ROOT)),
                    'layer_name':gdb.name,'status':'gdb_index_error: '+repr(e)})
    write_csv(PROC/'vectors'/'vector_layer_catalog.csv',['dataset','layer_path','layer_name','feature_count','geometry_type','crs','fields','status'],all_rows)
    log('vector_layer_extract_and_index','complete','geology and MGD3 ZIP archives',PROC/'vectors'/'vector_layer_catalog.csv',f'Indexed {len(all_rows)} shapefile and geodatabase layers; original archives retained.')
    print(f'Indexed {len(all_rows)} vector layers')

def build_routing_gpkg():
    import geopandas as gpd
    out=PROC/'vectors'/'routing_layers.gpkg'
    if out.exists(): print('Routing GeoPackage exists; skipping:',out); return
    layers=[
      ('geology_global',PROC/'vectors'/'source_layers'/'geology'/'SIM3292_MarsGlobalGeologicGIS_20M'/'SIM3292_Shapefiles'/'SIM3292_Global_Geology.shp'),
      ('dunes_equatorial',PROC/'vectors'/'source_layers'/'equatorial_dunes'/'Shapefiles'/'Geocentric'/'Dune_Field.shp'),
      ('dunes_north_polar',PROC/'vectors'/'source_layers'/'north_polar_dunes'/'NP_Shapefiles'/'Geocentric'/'NP_Dune_Field.shp'),
      ('dunes_south_polar',PROC/'vectors'/'source_layers'/'south_polar_dunes'/'SP_GIS_Download_Package'/'SP_Shapefiles'/'Geocentric'/'SP_Dune_Field_Geog.shp')]
    tmp=out.with_name('routing_layers.build.gpkg')
    if tmp.exists(): tmp.unlink()
    rows=[]
    for i,(layer,src) in enumerate(layers):
        if not src.is_file(): raise FileNotFoundError(src)
        frame=gpd.read_file(src)
        if frame.crs is None: raise ValueError(f'No CRS metadata for {src}')
        frame.to_file(tmp,layer=layer,driver='GPKG',mode='w' if i==0 else 'a',index=False)
        rows.append({'layer':layer,'source_file':str(src.relative_to(ROOT)),'feature_count':len(frame),
          'geometry_type':'|'.join(sorted(set(frame.geom_type.dropna()))),'crs':str(frame.crs),
          'note':'Source CRS preserved; dune coverage is regional/product-limited.'})
        print(f'Wrote GeoPackage layer {layer}: {len(frame)} features')
    tmp.replace(out)
    write_csv(PROC/'vectors'/'routing_layer_sources.csv',['layer','source_file','feature_count','geometry_type','crs','note'],rows)
    log('routing_vector_geopackage','complete','selected geology and MGD3 geographic source layers',out,'Four queryable layers; each retains source Mars CRS; no reprojection or inferred data.')
def verify_ai4mars():
    p=PROC/'ai4mars'/'manifest.csv'
    with p.open(newline='',encoding='utf-8-sig') as f: rows=list(csv.DictReader(f))
    counts={}; missing_matches=0; missing_labels=0; matched=0; review=0
    for x in rows:
        status=x['pair_status']; counts[status]=counts.get(status,0)+1
        label_ok=bool(x['label_path']) and Path(x['label_path']).is_file()
        if not label_ok: missing_labels+=1
        if status=='matched':
            matched+=1
            if not x['image_path'] or not Path(x['image_path']).is_file() or not label_ok: missing_matches+=1
        else: review+=1
    summary={'manifest_rows':len(rows),'matched_pairs':matched,'review_rows':review,
        'missing_matched_pairs':missing_matches,'missing_label_files':missing_labels,'pair_status_counts':counts}
    out=PROC/'ai4mars'/'manifest_validation.json'; out.write_text(json.dumps(summary,indent=2),encoding='utf-8')
    if missing_matches or missing_labels: raise RuntimeError(f'AI4Mars validation found {missing_matches} missing matched pairs and {missing_labels} missing labels')
    log('ai4mars_manifest_file_validation','complete',p,out,f"Validated {matched} matched image-label pairs; {review} unmatched/ambiguous labels retained for review.")
    print(f'AI4Mars verified: {matched} valid pairs; {review} unmatched/ambiguous labels retained for review')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--skip-dem',action='store_true'); ap.add_argument('--skip-vectors',action='store_true')
    args=ap.parse_args()
    verify_ai4mars(); index_climate()
    if not args.skip_vectors:
        extract_vectors(); build_routing_gpkg()
    if not args.skip_dem:
        dem=make_1km_dem(); make_slope(dem)
if __name__=='__main__': main()


