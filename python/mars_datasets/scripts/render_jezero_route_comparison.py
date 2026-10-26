"""Render the CTX A* vs vision-assisted A* routes over the CTX orthoimage."""
from pathlib import Path
import json,sys
import numpy as np
import rasterio
from PIL import Image,ImageDraw,ImageFont
from rasterio.windows import from_bounds
ROOT=Path(__file__).resolve().parent.parent
DATA=ROOT/"data/processed/vision_prototype/jezero_ctx"
IMAGE=ROOT/"data/raw/imagery/ctx_jezero_P18_007925_1987_XN_18N282W__P19_008650_1987_XI_18N282W_orthoimage.tif"
ROUTES=DATA/"route_comparison_ctx.json"
OUT=DATA/"route_comparison_ctx_warm.png"
RADIUS=3_396_190.0

def main():
    report=json.loads(ROUTES.read_text(encoding="utf-8")); features=report["route_geojson"]["features"]
    with rasterio.open(IMAGE) as src:
        coords=[p for f in features[:2] for p in f["geometry"]["coordinates"]]
        lon=[p[0] for p in coords]; lat=[p[1] for p in coords]
        west,east=min(lon)-.03,max(lon)+.03; south,north=min(lat)-.03,max(lat)+.03
        bounds=(RADIUS*np.deg2rad(west),RADIUS*np.deg2rad(south),RADIUS*np.deg2rad(east),RADIUS*np.deg2rad(north))
        window=from_bounds(*bounds,transform=src.transform).round_offsets().round_lengths()
        image=src.read(1,window=window,masked=True,out_dtype="float32")
        transform=src.window_transform(window)
    values=image.compressed(); lo,hi=np.percentile(values,[2,98]); gray=np.clip((image.filled(lo)-lo)/(hi-lo),0,1)
    # Warm Mars display palette matching the map imagery theme.
    rgb=np.stack((40+215*gray,15+145*gray,5+85*gray),axis=-1).astype(np.uint8)
    canvas=Image.fromarray(rgb,"RGB")
    target_w=1400; target_h=max(300,int(canvas.height*target_w/canvas.width))
    canvas=canvas.resize((target_w,target_h),Image.Resampling.BILINEAR)
    draw=ImageDraw.Draw(canvas,"RGBA")
    scale_x=target_w/rgb.shape[1]; scale_y=target_h/rgb.shape[0]
    def pixels(route):
        points=[]
        for lon0,lat0 in route:
            x=RADIUS*np.deg2rad(lon0); y=RADIUS*np.deg2rad(lat0)
            col,row=(~transform)*(x,y)
            points.append((col*scale_x,row*scale_y))
        return points
    base=pixels(features[0]["geometry"]["coordinates"]); vision=pixels(features[1]["geometry"]["coordinates"])
    draw.line(base,fill=(255,205,60,255),width=7,joint="curve")
    draw.line(vision,fill=(0,235,225,255),width=3,joint="curve")
    for point,color in ((base[0],(0,230,118,255)),(base[-1],(255,64,96,255))):
        x,y=point; draw.ellipse((x-9,y-9,x+9,y+9),fill=color,outline=(255,255,255,255),width=2)
    try: font=ImageFont.truetype("arial.ttf",18)
    except OSError: font=ImageFont.load_default()
    draw.rounded_rectangle((16,14,490,94),radius=10,fill=(15,12,10,220),outline=(255,190,110,170),width=1)
    draw.text((30,24),"Jezero | 20 m CTX stereo DTM | A* route comparison",font=font,fill=(255,245,230,255))
    draw.line((30,64,78,64),fill=(255,205,60,255),width=7); draw.text((90,52),"A* baseline",font=font,fill=(255,245,230,255))
    draw.line((240,64,288,64),fill=(0,235,225,255),width=4); draw.text((300,52),"A* + vision (0.05)",font=font,fill=(255,245,230,255))
    canvas.save(OUT)
    print(json.dumps({"saved":str(OUT),"size_px":canvas.size,"routes_drawn":2}))

if __name__=="__main__":
    try: main()
    except Exception as exc: print(f"Could not render route comparison: {exc}",file=sys.stderr); raise
