from __future__ import annotations
import csv
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
manifest=ROOT/'data'/'processed'/'ai4mars'/'manifest.csv'
output=ROOT/'data'/'processed'/'ai4mars'/'mask_pixel_distribution.csv'

# Decode independent PNG files concurrently; each worker returns compact counts only.
def scan_batch(batch):
    counts=Counter(); files=Counter(); dimensions=Counter(); errors=[]
    for task,split,label_text in batch:
        label=Path(label_text)
        try:
            with Image.open(label) as im:
                arr=np.asarray(im)
                if arr.ndim==3: arr=arr[:,:,0]
                h,w=arr.shape[:2]; files[(task,split)]+=1; dimensions[(task,split,h,w)]+=1
                vals,pixels=np.unique(arr,return_counts=True)
                for val,n in zip(vals,pixels): counts[(task,split,int(val))]+=int(n)
        except Exception as exc: errors.append(f'{label}: {exc!r}')
    return counts,files,dimensions,errors

with manifest.open(newline='',encoding='utf-8-sig') as f:
    rows=[(r.get('label_task','unknown'),r.get('source_split','unknown'),r['label_path'])
          for r in csv.DictReader(f) if r.get('pair_status')=='matched']
if any(not Path(x[2]).is_file() for x in rows): raise RuntimeError('Missing matched mask file; run preprocess_stage2.py validation first.')
batches=[rows[i:i+128] for i in range(0,len(rows),128)]
counts=Counter(); files=Counter(); dimensions=Counter(); errors=[]; finished=0
with ThreadPoolExecutor(max_workers=8) as pool:
    futures=[pool.submit(scan_batch,b) for b in batches]
    for future in as_completed(futures):
        c,f,d,e=future.result(); counts.update(c); files.update(f); dimensions.update(d); errors.extend(e)
        finished+=sum(f.values())
        if finished%4096<128 or finished==len(rows): print(f'Processed {finished:,}/{len(rows):,} masks',flush=True)
if errors:
    print('Mask read failures:',len(errors)); print('\n'.join(errors[:20]))
output.parent.mkdir(parents=True,exist_ok=True)
with output.open('w',newline='',encoding='utf-8') as f:
    w=csv.writer(f); w.writerow(['label_task','source_split','class_value','pixel_count','is_255_ignore_candidate','mask_files_in_group','mask_dimensions'])
    for (task,split,val),n in sorted(counts.items()):
        dims=';'.join(f'{h}x{width}:{c}' for (t,s,h,width),c in sorted(dimensions.items()) if t==task and s==split)
        w.writerow([task,split,val,n,val==255,files[(task,split)],dims])
print(f'Wrote {len(counts)} class-count rows for {sum(files.values()):,} masks to {output}')
