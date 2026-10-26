from __future__ import annotations
import csv, re
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin

ROOT=Path(__file__).resolve().parent.parent
RAW=ROOT/'data/raw/thermal_inertia/pds_mgs_tes_timap_v1/mgst_9001/data'
DEM=ROOT/'data/processed/rasters/global/mola_hrsc_blend_dem_1km.tif'
OUT=ROOT/'data/processed/rasters/global'
ROWS={
 'day':('global_ti_day_2007.img','global_ti_msk_day_2007.img'),
 'night':('global_ti_night_2007.img','global_ti_msk_night_2007.img')}

def label_value(path:Path,key:str):
 text=path.read_text(encoding='ascii',errors='replace')
 m=re.search(rf'^\s*{re.escape(key)}\s*=\s*([^\r\n]+)',text,re.M)
 if not m: raise ValueError(f'Missing {key} in {path}')
 return m.group(1).strip().strip('"')

def convert(name, img, mask_img, crs):
 label=RAW/(Path(img).stem+'.lbl'); mask_label=RAW/(Path(mask_img).stem+'.lbl')
 rows=int(label_value(label,'LINES')); cols=int(label_value(label,'LINE_SAMPLES'))
 bits=int(label_value(label,'SAMPLE_BITS')); sample=label_value(label,'SAMPLE_TYPE')
 res=float(label_value(label,'MAP_RESOLUTION').split()[0])
 west=float(label_value(label,'WESTERNMOST_LONGITUDE').split()[0]); north=float(label_value(label,'MAXIMUM_LATITUDE').split()[0])
 center_lat=float(label_value(label,'CENTER_LATITUDE').split()[0]); line_offset=float(label_value(label,'LINE_PROJECTION_OFFSET').split()[0])
 first_center_lat=center_lat+(1-line_offset)/res
 if bits!=16 or sample!='MSB_INTEGER': raise ValueError(f'Unexpected pixel type in {label}: {sample}/{bits}')
 data=np.fromfile(RAW/img,dtype='>i2')
 mask=np.fromfile(RAW/mask_img,dtype='u1')
 if data.size!=rows*cols or mask.size!=rows*cols: raise ValueError('PDS image dimensions do not match file sizes.')
 data=data.reshape(rows,cols)[::-1,:].astype('float32')
 # PDS states thermal-inertia results are computed only from 5 to 5000 tiu.
 data[(data<5)|(data>5000)]=np.nan
 mask=mask.reshape(rows,cols)[::-1,:].copy()
 transform=from_origin(west,north,1/res,1/res)
 profile={'driver':'GTiff','height':rows,'width':cols,'count':1,'dtype':'float32','crs':crs,
          'transform':transform,'nodata':np.nan,'tiled':True,'blockxsize':256,'blockysize':256,
          'compress':'deflate','predictor':3,'zlevel':6}
 out=OUT/f'tes_thermal_inertia_{name}_20ppd.tif'
 with rasterio.open(out,'w',**profile) as dst:
  dst.write(data,1); dst.update_tags(source='MGS TES TIMAP V1 PDS archive',units='J m-2 K-1 s-1/2',
    product=f'global_ti_{name}_2007',source_resolution_pix_per_degree=res,
    source_map_projection='simple cylindrical, planetocentric; PDS line order reversed to north-up GeoTIFF',
    source_map_radius_km=3396.0, source_product_creation_date='2007-01-30',
    source_interpolation_mask=str(OUT/f'tes_thermal_inertia_{name}_interpolation_mask_20ppd.tif'),
    rule_invalid_pixels='PDS stated valid product range is 5..5000 tiu; values outside range set to NoData')
 mask_out=OUT/f'tes_thermal_inertia_{name}_interpolation_mask_20ppd.tif'
 maskprof=profile|{'dtype':'uint8','nodata':None,'compress':'deflate','predictor':1}
 with rasterio.open(mask_out,'w',**maskprof) as dst:
  dst.write(mask,1); dst.update_tags(source='PDS interpolation mask',value_0='interpolated/infilled',value_1='not infilled')
 valid=data[np.isfinite(data)]; observed=valid[mask[np.isfinite(data)]==1]; infilled=valid[mask[np.isfinite(data)]==0]
 return {'layer':name,'source_image':img,'source_mask':mask_img,'resolution_pix_per_degree':res,
  'rows':rows,'columns':cols,'latitude_first_record_center_south_deg':first_center_lat,
  'valid_pixels':int(valid.size),'valid_min_tiu':float(valid.min()),'valid_max_tiu':float(valid.max()),
  'valid_mean_tiu':float(valid.mean()),'interpolated_valid_pixels':int(infilled.size),
  'interpolated_fraction_of_valid':float(infilled.size/valid.size),
  'output_geotiff':str(out.relative_to(ROOT)),'output_interpolation_mask':str(mask_out.relative_to(ROOT)),
  'notes':'0 mask means interpolated/infilled; retain mask for uncertainty handling. Values are not slip or soil-strength measurements.'}

def main():
 OUT.mkdir(parents=True,exist_ok=True)
 with rasterio.open(DEM) as dem: crs=dem.crs
 summary=[convert(k,*v,crs) for k,v in ROWS.items()]
 p=ROOT/'data/processed/rasters/global/tes_thermal_inertia_summary.csv'
 with p.open('w',newline='',encoding='utf-8') as f:
  w=csv.DictWriter(f,fieldnames=list(summary[0]));w.writeheader();w.writerows(summary)
 print(f'Created {len(summary)*2} georeferenced global rasters and {p}')
 for row in summary: print(f"{row['layer']}: {row['valid_pixels']:,} valid pixels; {row['interpolated_fraction_of_valid']:.2%} interpolated; {row['valid_min_tiu']:.1f}..{row['valid_max_tiu']:.1f} tiu")
if __name__=='__main__': main()
