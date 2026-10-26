from __future__ import annotations
import argparse, shutil, tarfile, tempfile
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parent.parent
BASE='https://www-mars.lmd.jussieu.fr/MCD_pro/32591/addons/'
RAW=ROOT/'data/raw/climate/mcd_addons'
DATA=ROOT/'data/processed/climate/mcd_6.2_bundle/MCD_6.2/data'
DEFAULT=['clim_minEUV','clim_maxEUV','cold','warm','strm']
RESERVE=12*1024**3

def head_size(url):
 with urlopen(Request(url,method='HEAD',headers={'User-Agent':'MarsRoutePlannerDataPrep/1.0'}),timeout=40) as r:
  return int(r.headers.get('Content-Length',0))

def download(url,dest,total):
 dest.parent.mkdir(parents=True,exist_ok=True); part=dest.with_suffix(dest.suffix+'.part')
 offset=part.stat().st_size if part.exists() else 0
 if offset>=total and total: part.replace(dest); return
 headers={'User-Agent':'MarsRoutePlannerDataPrep/1.0'}
 if offset: headers['Range']=f'bytes={offset}-'
 try: response=urlopen(Request(url,headers=headers),timeout=90)
 except HTTPError as e:
  if offset and e.code==416: part.replace(dest); return
  raise
 status=getattr(response,'status',200)
 if offset and status!=206:
  response.close(); offset=0; part.unlink(missing_ok=True)
  response=urlopen(Request(url,headers={'User-Agent':'MarsRoutePlannerDataPrep/1.0'}),timeout=90)
 mode='ab' if offset else 'wb'; done=offset; last=-1
 with response,part.open(mode) as f:
  while True:
   block=response.read(2*1024*1024)
   if not block: break
   f.write(block); done+=len(block)
   pct=int(100*done/total) if total else 0
   if pct//5!=last//5:
    print(f'  {dest.name}: {pct}% ({done/1024**3:.2f}/{total/1024**3:.2f} GiB)',flush=True); last=pct
 if total and done!=total: raise RuntimeError(f'Incomplete {dest}: got {done}, expected {total} bytes; rerun to resume.')
 part.replace(dest)

def extract_netcdf(archive,scenario):
 folder=DATA/scenario; folder.mkdir(parents=True,exist_ok=True)
 temp_root=Path(tempfile.mkdtemp(prefix=f'mcd_{scenario}_',dir=RAW))
 try:
  with tarfile.open(archive,'r:gz') as tf:
   members=tf.getmembers(); extracted=0; total_bytes=sum(m.size for m in members if m.isfile())
   free=shutil.disk_usage(DATA).free
   if free < total_bytes+RESERVE:
    raise RuntimeError(f'Not enough free space to unpack {scenario}: need about {total_bytes/1024**3:.1f} GiB plus 12 GiB reserve; free {free/1024**3:.1f} GiB.')
   for m in members:
    rel=PurePosixPath(m.name)
    if rel.is_absolute() or '..' in rel.parts or not (m.isfile() or m.isdir()):
     if m.isdir(): continue
     raise RuntimeError(f'Refusing unsafe/nonregular tar entry: {m.name}')
   tf.extractall(temp_root,members=members)
  files=[p for p in temp_root.rglob('*') if p.is_file() and (p.suffix.lower()=='.nc' or p.name.lower() in {'readme','readme.txt'})]
  n=0
  for src in files:
   dst=folder/src.name
   if dst.exists() and dst.stat().st_size==src.stat().st_size: continue
   shutil.copy2(src,dst); n+=1
  nc=list(folder.glob('*.nc'))
  if not nc: raise RuntimeError(f'No NetCDF files found when unpacking {archive.name}; inspect extracted archive at {temp_root}')
  print(f'  Extracted {n} files to {folder.name}; {len(nc)} NetCDF files are now in the scenario folder.',flush=True)
 finally:
  shutil.rmtree(temp_root,ignore_errors=True)

def main():
 ap=argparse.ArgumentParser(description='Download and install the official MCD 6.2 non-MY scenario add-ons.')
 ap.add_argument('--scenarios',nargs='+',default=DEFAULT,help='Scenario archive names; default: climatology min/max EUV, cold, warm, and storm.')
 args=ap.parse_args(); RAW.mkdir(parents=True,exist_ok=True)
 totals={}
 for name in args.scenarios:
  if not (name.startswith('clim_') or name in {'cold','warm','strm'} or (name.startswith('MY') and name[2:].isdigit())):
   ap.error(f'Invalid scenario: {name}')
  totals[name]=head_size(BASE+name+'.tar.gz')
  print(f'{name}: official archive {totals[name]/1024**3:.2f} GiB',flush=True)
 need=sum(totals.values()); free=shutil.disk_usage(RAW).free
 if free < need+RESERVE:
  raise SystemExit(f'Not enough disk space to keep the selected archives and a 12 GiB reserve: need {need/1024**3:.1f} GiB archives; free {free/1024**3:.1f} GiB.')
 for name,total in totals.items():
  archive=RAW/(name+'.tar.gz')
  if archive.exists() and archive.stat().st_size==total: print(f'Skipping existing archive: {archive.name}',flush=True)
  else:
   print(f'Downloading {name}...',flush=True); download(BASE+name+'.tar.gz',archive,total)
  expected=DATA/name
  if expected.exists() and any(expected.glob('*.nc')): print(f'Scenario already extracted: {name}',flush=True)
  else: extract_netcdf(archive,name)
 print('MCD add-on download/preparation complete.',flush=True)
if __name__=='__main__': main()
