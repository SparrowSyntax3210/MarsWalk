from __future__ import annotations
import argparse, csv, json, math
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd
import rasterio
from rasterio.features import rasterize
from rasterio.windows import Window, from_bounds
import geopandas as gpd
from pyproj import CRS, Transformer
from scipy.spatial import cKDTree
from scipy.ndimage import maximum_filter, minimum_filter
from shapely import distance as shapely_distance, make_valid, points as shapely_points
from shapely.geometry import LineString, Point, box
from shapely.ops import transform as geom_transform
from shapely.strtree import STRtree
from mcd_sampler import MCDSampler

ROOT=Path(__file__).resolve().parent.parent
PROC=ROOT/'data'/'processed'
DEM=PROC/'rasters'/'global'/'mola_hrsc_blend_dem_1km.tif'
SLOPE=PROC/'rasters'/'global'/'mola_hrsc_blend_slope_deg_1km.tif'
GPKG=PROC/'vectors'/'routing_layers.gpkg'
CRATERS=PROC/'vectors'/'robbins_craters.csv'
TES_DAY=PROC/'rasters'/'global'/'tes_thermal_inertia_day_20ppd.tif'
TES_NIGHT=PROC/'rasters'/'global'/'tes_thermal_inertia_night_20ppd.tif'
TES_DAY_MASK=PROC/'rasters'/'global'/'tes_thermal_inertia_day_interpolation_mask_20ppd.tif'
TES_NIGHT_MASK=PROC/'rasters'/'global'/'tes_thermal_inertia_night_interpolation_mask_20ppd.tif'
RADIUS_M=3_389_500.0
GEOLOGY_LAYER='geology_global'
DUNE_LAYERS=('dunes_equatorial','dunes_north_polar','dunes_south_polar')
CLIMATE_VARS=('tsurf','ps','tau_pref_gcm','temp','u','v','rho','col_h2ovapor','col_h2oice','co2ice','h2oice','fluxsurf_dn_sw','fluxsurf_lw','fluxsurf_dir_dn_sw','fluxsurf_up_sw')

def normalize_lon(lon): return ((np.asarray(lon,dtype=float)+180.0)%360.0)-180.0

def route_bbox(start,end,corridor_km,dem_crs):
    lat1,lon1=start; lat2,lon2=end
    if not (-90<=lat1<=90 and -90<=lat2<=90): raise ValueError('Start/end latitude must be within -90 to 90 degrees.')
    lon1=float(normalize_lon(lon1)); lon2=float(normalize_lon(lon2))
    delta=(lon2-lon1+180)%360-180; lon2_unwrapped=lon1+delta
    center_lon=(lon1+lon2_unwrapped)/2; center_lon=float(normalize_lon(center_lon)); center_lat=(lat1+lat2)/2
    if abs(delta)>120: raise ValueError('For a very long route, pass a focused --bounds window rather than one route corridor.')
    local=CRS.from_proj4(f'+proj=aeqd +lat_0={center_lat} +lon_0={center_lon} +R={RADIUS_M} +units=m +no_defs +type=crs')
    forward=Transformer.from_crs(dem_crs,local,always_xy=True); inverse=Transformer.from_crs(local,dem_crs,always_xy=True)
    x1,y1=forward.transform(lon1,lat1); x2,y2=forward.transform(lon2_unwrapped,lat2)
    line=LineString([(x1,y1),(x2,y2)]) if math.hypot(x2-x1,y2-y1)>1 else Point(x1,y1)
    polygon=line.buffer(float(corridor_km)*1000.0,cap_style='round',join_style='round')
    geographic=geom_transform(inverse.transform,polygon)
    coords=np.asarray(geographic.exterior.coords)
    unwrapped=center_lon+((coords[:,0]-center_lon+180)%360-180)
    west=float(unwrapped.min()); east=float(unwrapped.max()); south=float(coords[:,1].min()); north=float(coords[:,1].max())
    return split_bbox(west,south,east,north),{'west':west,'south':south,'east':east,'north':north,'corridor_km':corridor_km}

def split_bbox(west,south,east,north):
    if east-west>=360: return [(-180.0,south,180.0,north)]
    if west < -180:
        return [(west+360,south,180.0,north),(-180.0,south,east,north)]
    if east > 180:
        return [(west,south,180.0,north),(-180.0,south,east-360,north)]
    return [(west,south,east,north)]

def window_for_bbox(src,bounds):
    west,south,east,north=bounds
    w=from_bounds(west,south,east,north,src.transform)
    c0=max(0,int(math.floor(w.col_off))); r0=max(0,int(math.floor(w.row_off)))
    c1=min(src.width,int(math.ceil(w.col_off+w.width))); r1=min(src.height,int(math.ceil(w.row_off+w.height)))
    if c1<=c0 or r1<=r0: return None
    return Window(c0,r0,c1-c0,r1-r0)

def _load_vectors(target_crs):
    geology=gpd.read_file(GPKG,layer=GEOLOGY_LAYER)
    if geology.crs is None: raise ValueError('Geology source has no CRS metadata.')
    if geology.crs!=target_crs: geology=geology.to_crs(target_crs)
    dunes=[]
    for layer in DUNE_LAYERS:
        frame=gpd.read_file(GPKG,layer=layer)
        if frame.crs is None: raise ValueError(f'{layer} has no CRS metadata.')
        if frame.crs!=target_crs: frame=frame.to_crs(target_crs)
        dunes.append((layer,frame))
    return geology,dunes

def _geology_codes(geology):
    units=sorted(str(x) for x in geology['Unit'].dropna().unique())
    mapping={name:i+1 for i,name in enumerate(units)}
    desc={str(r['Unit']):str(r.get('UnitDesc','')) for _,r in geology[['Unit','UnitDesc']].dropna(subset=['Unit']).drop_duplicates('Unit').iterrows()}
    codebook=PROC/'vectors'/'geology_unit_codebook.csv'
    codebook.parent.mkdir(parents=True,exist_ok=True)
    with codebook.open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f); w.writerow(['geology_unit_code','source_unit_code','description'])
        for unit,code in mapping.items(): w.writerow([code,unit,desc.get(unit,'')])
    return mapping

def _rasterize_units(frame,mapping,transform,shape,bounds):
    west,south,east,north=bounds
    clipped=frame.cx[west:east,south:north]
    items=[]
    for geom,unit in zip(clipped.geometry,clipped['Unit']):
        if geom is not None and not geom.is_empty and pd.notna(unit): items.append((geom,int(mapping[str(unit)])))
    if not items: return np.zeros(shape,dtype=np.int32)
    return rasterize(items,out_shape=shape,transform=transform,fill=0,dtype='int32',all_touched=False)

def _rasterize_dunes(frames,transform,shape,bounds):
    west,south,east,north=bounds; items=[]
    for _,frame in frames:
        clipped=frame.cx[west:east,south:north]
        items.extend((g,1) for g in clipped.geometry if g is not None and not g.is_empty)
    if not items: return np.zeros(shape,dtype=np.uint8)
    return rasterize(items,out_shape=shape,transform=transform,fill=0,dtype='uint8',all_touched=False)

def _dune_distance_km(frame, dune_frames):
    """Approximate distance to the nearest mapped dune polygon in a local Mars AEQD projection."""
    geometries=[]
    for _, layer in dune_frames:
        geometries.extend(g for g in layer.geometry if g is not None and not g.is_empty)
    if not geometries:
        return np.full(len(frame), np.nan, dtype='float32')
    lat=np.asarray(frame['latitude_deg'],dtype=float)
    lon=np.asarray(frame['longitude_east_deg'],dtype=float)
    lat0=float(np.mean(lat))
    # Circular mean avoids choosing the wrong projection center near the date line.
    lon_rad=np.deg2rad(lon)
    lon0=float(np.rad2deg(np.arctan2(np.sin(lon_rad).mean(),np.cos(lon_rad).mean())))
    local=CRS.from_proj4(f'+proj=aeqd +lat_0={lat0} +lon_0={lon0} +R={RADIUS_M} +units=m +no_defs +type=crs')
    source=CRS.from_user_input(dune_frames[0][1].crs)
    project=Transformer.from_crs(source,local,always_xy=True).transform
    projected=[]
    for geom in geometries:
        repaired=geom if geom.is_valid else make_valid(geom)
        if repaired is None or repaired.is_empty:
            continue
        local_geom=geom_transform(project,repaired)
        # Projection can introduce self-intersections in distant/polar source polygons.
        if not local_geom.is_valid:
            local_geom=make_valid(local_geom)
        if not local_geom.is_empty:
            projected.append(local_geom)
    if not projected:
        return np.full(len(frame), np.nan, dtype='float32')
    # A nearest-feature index avoids a planet-wide polygon union, which can fail on
    # overlapping or polar source geometries and is unnecessary for point distances.
    tree=STRtree(projected)
    to_local=Transformer.from_crs(CRS.from_proj4(f'+proj=longlat +R={RADIUS_M} +no_defs +type=crs'),local,always_xy=True)
    x,y=to_local.transform(lon,lat)
    query_points=shapely_points(x,y)
    nearest=tree.nearest(query_points)
    distances=shapely_distance(query_points,np.asarray(projected,dtype=object)[nearest])/1000.0
    return np.asarray(distances,dtype='float32')

def _terrain_attributes(elevation, transform, latitude_grid):
    z=np.asarray(elevation,dtype='float32')
    dz_dcol=np.gradient(z,axis=1) if z.shape[1]>1 else np.zeros_like(z)
    dz_drow=np.gradient(z,axis=0) if z.shape[0]>1 else np.zeros_like(z)
    dx=RADIUS_M*np.deg2rad(abs(transform.a))*np.maximum(np.cos(np.deg2rad(latitude_grid)),1e-6)
    dy=RADIUS_M*np.deg2rad(abs(transform.e))
    down_east=-dz_dcol/dx
    down_north=dz_drow/dy
    aspect=(np.degrees(np.arctan2(down_east,down_north))+360.0)%360.0
    gradient=np.hypot(down_east,down_north)
    aspect[gradient<1e-8]=np.nan
    roughness=maximum_filter(z,size=3,mode='nearest')-minimum_filter(z,size=3,mode='nearest')
    return aspect.astype('float32'),roughness.astype('float32')

def _sample_raster(path, longitude, latitude):
    with rasterio.open(path) as src:
        samples=src.sample(zip(longitude,latitude),masked=True)
        return np.array([np.nan if np.ma.is_masked(v[0]) else float(v[0]) for v in samples],dtype='float32')

def _sphere_xyz(lat,lon):
    lat=np.deg2rad(np.asarray(lat,dtype=float)); lon=np.deg2rad(np.asarray(lon,dtype=float)); c=np.cos(lat)
    return np.column_stack((c*np.cos(lon),c*np.sin(lon),np.sin(lat)))

def _crater_distance_km(lat,lon,craters,tree,max_radius_km):
    # Vectorized nearest-center estimate scales to broad tiles; catalog entries are points,
    # not mapped crater-rim polygons, so the result is explicitly approximate.
    points=_sphere_xyz(lat,lon); chord,nearest=tree.query(points,k=1)
    d0=2*RADIUS_M*np.arcsin(np.clip(chord/2,0,1))/1000.0
    radii=craters['diameter_km'].to_numpy(dtype=float)/2.0
    dist=np.maximum(0,d0-radii[nearest])
    return dist,craters['crater_id'].astype(str).to_numpy()[nearest]

def main():
    ap=argparse.ArgumentParser(description='Build a local Parquet route-grid table from the available Mars layers.')
    ap.add_argument('--start',nargs=2,type=float,metavar=('LAT','LON'))
    ap.add_argument('--end',nargs=2,type=float,metavar=('LAT','LON'))
    ap.add_argument('--bounds',nargs=4,type=float,metavar=('WEST','SOUTH','EAST','NORTH'),help='Optional explicit lon/lat window; WEST>EAST crosses the date line.')
    ap.add_argument('--corridor-km',type=float,default=20.0,help='Half-width around the start/end line.')
    ap.add_argument('--stride',type=int,default=1,help='Keep every Nth terrain cell (1 = all nominal 1 km cells).')
    ap.add_argument('--output',type=Path,help='Output Parquet path. Defaults to data/processed/route_grid/region_<timestamp>.parquet.')
    ap.add_argument('--no-csv',action='store_true',help='Write only Parquet and its manifest; avoids a large duplicate CSV.')
    ap.add_argument('--ls',type=float,help='MCD solar longitude; supply together with --local-time to add climate features.')
    ap.add_argument('--local-time',type=float,help='MCD local true solar time, 0..24 Martian hours.')
    ap.add_argument('--mcd-altitude-km',type=float,default=0.00448064,help='MCD pseudo-altitude coordinate in km for atmospheric fields.')
    ap.add_argument('--mcd-scenario',default='clim_aveEUV',help='Installed MCD scenario directory or scenario code.')
    args=ap.parse_args()
    if args.stride<1: ap.error('--stride must be at least 1')
    if (args.ls is None)!=(args.local_time is None): ap.error('Supply both --ls and --local-time to add MCD fields.')
    if bool(args.bounds)==bool(args.start or args.end): ap.error('Supply either --bounds or both --start and --end.')
    if (args.start is None)!=(args.end is None): ap.error('Both --start and --end are required together.')
    if args.corridor_km<=0: ap.error('--corridor-km must be positive.')
    if not DEM.is_file() or not SLOPE.is_file() or not GPKG.is_file() or not CRATERS.is_file():
        raise FileNotFoundError('Required stage-two raster, vector, or crater outputs are missing; run preprocess_stage2.py first.')
    with rasterio.open(DEM) as dem, rasterio.open(SLOPE) as slope:
        if dem.transform!=slope.transform or dem.shape!=slope.shape: raise ValueError('DEM/slope grids are not aligned.')
        if args.bounds:
            west,south,east,north=args.bounds
            if not (-90<=south<north<=90): raise ValueError('Bounds latitude must satisfy -90 <= south < north <= 90.')
            regions=split_bbox(west,south,east,north); bbox={'west':west,'south':south,'east':east,'north':north}
        else:
            regions,bbox=route_bbox(tuple(args.start),tuple(args.end),args.corridor_km,dem.crs)
        geology,dunes=_load_vectors(dem.crs); mapping=_geology_codes(geology)
        crater=pd.read_csv(CRATERS,dtype={'crater_id':str}); max_radius=float(crater['diameter_km'].max()/2)
        tree=cKDTree(_sphere_xyz(crater['latitude_deg'].to_numpy(),crater['longitude_east_deg'].to_numpy()))
        chunks=[]; total_cells=0
        for bounds in regions:
            win=window_for_bbox(dem,bounds)
            if win is None: continue
            h,w=int(win.height),int(win.width); total_cells+=math.ceil(h/args.stride)*math.ceil(w/args.stride)
            if total_cells>5_000_000: raise ValueError(f'Requested grid exceeds 5 million cells ({total_cells:,}); increase --stride or reduce corridor/bounds.')
            elev=dem.read(1,window=win); slp=slope.read(1,window=win)
            transform=dem.window_transform(win)
            rr0,cc0=np.meshgrid(np.arange(int(win.row_off),int(win.row_off)+h),np.arange(int(win.col_off),int(win.col_off)+w),indexing='ij')
            lat_full=dem.transform.f+(rr0+0.5)*dem.transform.e
            aspect_full,roughness_full=_terrain_attributes(elev,transform,lat_full)
            geo=_rasterize_units(geology,mapping,transform,(h,w),bounds)[::args.stride,::args.stride]
            dune=_rasterize_dunes(dunes,transform,(h,w),bounds)[::args.stride,::args.stride]
            elev=elev[::args.stride,::args.stride].astype('float32'); slp=slp[::args.stride,::args.stride].astype('float32')
            ro=int(win.row_off)+np.arange(0,h,args.stride); co=int(win.col_off)+np.arange(0,w,args.stride)
            rr,cc=np.meshgrid(ro,co,indexing='ij')
            lon=dem.transform.c+(cc+0.5)*dem.transform.a; lat=dem.transform.f+(rr+0.5)*dem.transform.e
            valid=(elev!=dem.nodata if dem.nodata is not None else np.isfinite(elev)) & (slp!=slope.nodata if slope.nodata is not None else np.isfinite(slp))
            rows={'row':rr[valid].astype('int32'),'col':cc[valid].astype('int32'),
                  'latitude_deg':lat[valid].astype('float32'),'longitude_east_deg':normalize_lon(lon[valid]).astype('float32'),
                  'elevation_m':elev[valid],'slope_deg':slp[valid],
                  'aspect_deg':aspect_full[::args.stride,::args.stride][valid],
                  'roughness_3x3_range_m':roughness_full[::args.stride,::args.stride][valid],
                  'cell_width_m':(RADIUS_M*np.deg2rad(abs(dem.transform.a))*np.cos(np.deg2rad(lat[valid]))).astype('float32'),
                  'cell_height_m':np.full(valid.sum(),RADIUS_M*np.deg2rad(abs(dem.transform.e)),dtype='float32'),
                  'geology_unit_code':geo[valid].astype('int32'),'dune_hit':dune[valid].astype('uint8')}
            chunks.append(pd.DataFrame(rows))
        if not chunks: raise ValueError('The requested route window does not intersect the global raster.')
        frame=pd.concat(chunks,ignore_index=True)
    frame['geology_unit_code']=frame['geology_unit_code'].replace(0,pd.NA).astype('Int32')
    frame['dune_distance_km']=_dune_distance_km(frame,dunes)
    distance,crater_id=_crater_distance_km(frame['latitude_deg'].to_numpy(),frame['longitude_east_deg'].to_numpy(),crater,tree,max_radius)
    frame['crater_edge_distance_km']=distance.astype('float32'); frame['nearest_crater_id']=crater_id
    # TES layers are much coarser than the DEM; sample native cells and retain mask flags.
    thermal_layers=((TES_DAY,'tes_ti_day_tiu'),(TES_NIGHT,'tes_ti_night_tiu'),
                    (TES_DAY_MASK,'tes_ti_day_infilled'),(TES_NIGHT_MASK,'tes_ti_night_infilled'))
    present=[(p,col) for p,col in thermal_layers if p.is_file()]
    for path,col in present:
        values=_sample_raster(path,frame['longitude_east_deg'].to_numpy(),frame['latitude_deg'].to_numpy())
        if 'infilled' in col:
            frame[col]=pd.array([int(v) if np.isfinite(v) else pd.NA for v in values],dtype='UInt8')
        else:
            frame[col]=values
    if 'tes_ti_day_tiu' in frame and 'tes_ti_night_tiu' in frame:
        stack=np.column_stack([frame['tes_ti_day_tiu'].to_numpy(),frame['tes_ti_night_tiu'].to_numpy()])
        count=np.isfinite(stack).sum(axis=1); total=np.nansum(stack,axis=1)
        frame['tes_ti_mean_tiu']=np.divide(total,count,out=np.full(len(frame),np.nan),where=count>0).astype('float32')
    climate_meta=None; units=None
    if args.ls is not None:
        sampler=MCDSampler(scenario=args.mcd_scenario)
        vals,units,climate_meta=sampler.sample_many(frame['latitude_deg'].to_numpy(),frame['longitude_east_deg'].to_numpy(),
            args.ls,args.local_time,args.mcd_altitude_km,variables=CLIMATE_VARS)
        for name,value in vals.items(): frame['mcd_'+name]=value.astype('float32')
    # Deterministic transformations of available measurements; these are not learned mobility labels.
    frame['slope_grade_pct']=(np.tan(np.deg2rad(frame['slope_deg'].to_numpy(dtype='float64')))*100.0).astype('float32')
    if 'tes_ti_day_tiu' in frame and 'tes_ti_night_tiu' in frame:
        frame['tes_ti_day_night_delta_tiu']=(frame['tes_ti_day_tiu']-frame['tes_ti_night_tiu']).astype('float32')
    if 'mcd_u' in frame and 'mcd_v' in frame:
        u=frame['mcd_u'].to_numpy(dtype='float64'); v=frame['mcd_v'].to_numpy(dtype='float64')
        frame['mcd_wind_direction_to_deg']=(np.degrees(np.arctan2(u,v))+360.0)%360.0
        frame['mcd_wind_direction_to_deg']=frame['mcd_wind_direction_to_deg'].astype('float32')
    if 'mcd_ps' in frame:
        frame['mcd_ps_kpa']=(frame['mcd_ps']/1000.0).astype('float32')
    for source,target in [('mcd_col_h2ovapor','mcd_col_h2ovapor_mm_water_equiv'),('mcd_col_h2oice','mcd_col_h2oice_mm_water_equiv'),('mcd_h2oice','mcd_h2oice_surface_mm_water_equiv')]:
        if source in frame: frame[target]=frame[source].astype('float32') # 1 kg/m2 = 1 mm water-equivalent
    out=args.output or (PROC/'route_grid'/f"region_{datetime.now().strftime('%Y%m%d_%H%M%S')}.parquet")
    out=Path(out); out.parent.mkdir(parents=True,exist_ok=True)
    frame.to_parquet(out,index=False,compression='zstd')
    csv_out=None if args.no_csv else out.with_suffix('.csv')
    if csv_out is not None: frame.to_csv(csv_out,index=False,na_rep='')
    nearest={}
    if args.start and args.end:
        for key,point in [('start',args.start),('end',args.end)]:
            lat0,lon0=point; dlat=np.deg2rad(frame['latitude_deg'].to_numpy()-lat0)
            dlon=np.deg2rad(((frame['longitude_east_deg'].to_numpy()-lon0+180)%360)-180)
            a=np.sin(dlat/2)**2+np.cos(np.deg2rad(lat0))*np.cos(np.deg2rad(frame['latitude_deg'].to_numpy()))*np.sin(dlon/2)**2
            j=int(np.argmin(a)); nearest[key]={'row':int(frame.iloc[j]['row']),'col':int(frame.iloc[j]['col']),
                'lat':float(frame.iloc[j]['latitude_deg']),'lon':float(frame.iloc[j]['longitude_east_deg'])}
    manifest={'created_utc':datetime.now(timezone.utc).isoformat(timespec='seconds'),'output':str(out),
      'cells':len(frame),'bbox_lonlat':bbox,'segments':regions,'stride':args.stride,
      'terrain_resolution':'nominal 1 km at equator multiplied by stride',
      'source_crs':rasterio.open(DEM).crs.to_string(),'features':list(frame.columns),'csv_export':str(csv_out) if csv_out else None,
      'terrain_attribute_semantics':'aspect_deg is downslope compass bearing, undefined for flat cells. roughness_3x3_range_m is the local 3x3 DEM elevation max-minus-min; it is scale-dependent.',
      'thermal_inertia_semantics':'TES 20 ppd thermal inertia values are sampled at their native grid; day/night products are separate and mean is their available-value average. Infilled flags are 0=infilled, 1=not infilled. These are material-property proxies, not wheel-slip measurements.',
      'geology_codebook':'data/processed/vectors/geology_unit_codebook.csv',
      'dune_semantics':'dune_hit=1 means a cell intersects an included MGD3 dune polygon. 0 means no included polygon hit; it does not prove dune absence outside mapped product coverage.',
      'dune_distance_semantics':'Minimum planar distance from each cell center to the union of included MGD3 dune polygons after projection into a local Mars spherical azimuthal-equidistant CRS; accurate for regional windows, approximate for very broad windows. A value of 0 means inside/on a mapped polygon. Product coverage remains incomplete, so distance is to mapped dunes only.',
      'crater_distance_semantics':'Spherical center distance minus half source diameter, clamped to zero; not a measured rim polygon.',
      'derived_feature_semantics':{'slope_grade_pct':'100*tan(slope_deg in radians); geometric grade, not rover traversability.','tes_ti_day_night_delta_tiu':'day thermal inertia minus night thermal inertia; diagnostic material proxy, not slip.','mcd_wind_direction_to_deg':'wind vector direction toward clockwise from north, computed as (atan2(u,v) in degrees + 360) modulo 360.','mcd_ps_kpa':'MCD pressure Pa divided by 1000.','mcd_*_mm_water_equiv':'MCD column water/ice kg m-2 converted using 1 kg m-2 = 1 mm water-equivalent; not subsurface ice depth.'},
      'mcd_spatial_resolution_note':'MCD variables are interpolated from the native GCM grid and repeated at terrain-cell locations; they are not independent 1 km measurements.',
      'mcd_data_quality_notes':['Check shortwave-flux outputs against the MCD local-time convention before using them for route scoring; daylight should not be inferred from a zero-valued field without validation.','MEDA rover observations and AI4Mars image labels are not automatically spatially registered to every terrain cell.'],
      'nearest_endpoint_cells':nearest,'mcd':climate_meta,'mcd_units':units if climate_meta else None}
    sidecar=out.with_suffix('.manifest.json'); sidecar.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps({'parquet':str(out),'csv':str(csv_out) if csv_out else None,'manifest':str(sidecar),'cells':len(frame),'columns':list(frame.columns),'nearest_endpoint_cells':nearest},indent=2))

if __name__=='__main__': main()



