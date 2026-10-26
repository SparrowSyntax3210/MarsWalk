from __future__ import annotations
import csv, re, shutil, zipfile
from collections import defaultdict, Counter
from pathlib import Path, PurePosixPath

ROOT=Path(__file__).resolve().parent.parent
ARCHIVE=ROOT/'data/raw/ai4mars/ai4mars-dataset-merged-0.6.zip'
OUT=ROOT/'data/processed/ai4mars'
EXTRACT=OUT/'source'
STAGE=OUT/'.source_extracting'


def group(path: str) -> str:
    p=path.lower().split('/')
    if len(p)>2 and p[1]=='msl': return 'msl/'+p[2]
    return p[1] if len(p)>1 else 'unknown'

def normalized(path: str, is_label: bool) -> str:
    s=Path(path).stem
    s=re.sub(r'_merged\d*$','',s,flags=re.I)
    if is_label and '/msl/mcam/labels/' in path.lower():
        s=re.sub(r'_\d+$','',s)
    s=re.sub(r'-[1-3]_rectified$', '_rectified',s,flags=re.I)
    if not is_label:
        s=re.sub(r'_0LLJ$','',s,flags=re.I)
    return s.casefold()

def split_of(label: str) -> str:
    low=label.lower()
    if '/labels/train/' in low: return 'train'
    if '/labels/test/' in low: return 'test'
    if '/m2020/labels/' in low: return 'train_source_merged_no_test_split'
    return 'unspecified'

def task_of(label: str) -> str:
    low=label.lower()
    if '/labels/nav/' in low: return 'NAV'
    if '/labels/m2020_geo/' in low: return 'M2020_GEO'
    # Historical MSL / MER labels are NAV labels; preserve source-derived group.
    return 'NAV'

def safe_extract(z: zipfile.ZipFile, destination: Path) -> tuple[int,int]:
    total=sum(i.file_size for i in z.infolist())
    free=shutil.disk_usage(destination.parent).free
    if free < total + 3*1024**3:
        raise RuntimeError(f'Insufficient free space: need about {total/1e9:.2f} GB plus 3 GB safety; have {free/1e9:.2f} GB')
    destination.mkdir(parents=True,exist_ok=False)
    count=done=0
    try:
        for info in z.infolist():
            rel=PurePosixPath(info.filename)
            if rel.is_absolute() or '..' in rel.parts:
                raise ValueError(f'Unsafe ZIP path: {info.filename}')
            out=destination.joinpath(*rel.parts)
            if info.is_dir():
                out.mkdir(parents=True,exist_ok=True)
                continue
            out.parent.mkdir(parents=True,exist_ok=True)
            with z.open(info,'r') as src, out.open('wb') as dst:
                shutil.copyfileobj(src,dst,1024*1024)
            count+=1; done+=info.file_size
            if count % 10000==0:
                print(f'AI4Mars extraction: {count:,} files; {done/1e9:.2f} GB written',flush=True)
        return count,done
    except Exception:
        print(f'Partial extraction retained at {destination} for inspection; do not treat as complete.',flush=True)
        raise

def main():
    if not ARCHIVE.is_file(): raise FileNotFoundError(ARCHIVE)
    OUT.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(ARCHIVE) as z:
        infos=[i for i in z.infolist() if not i.is_dir()]
        images=[i.filename for i in infos if '/images/' in i.filename and Path(i.filename).suffix.lower() in ('.jpg','.jpeg')]
        labels=[i.filename for i in infos if '/labels/' in i.filename and Path(i.filename).suffix.lower()=='.png']
        image_map=defaultdict(list)
        for image in images: image_map[(group(image),normalized(image,False))].append(image)
        rows=[]; counts=Counter()
        for label in labels:
            g=group(label); k=normalized(label,True); choices=image_map.get((g,k),[])
            status='matched' if len(choices)==1 else ('ambiguous_image_match' if len(choices)>1 else 'unmatched_image')
            image=choices[0] if len(choices)==1 else ''
            split=split_of(label); task=task_of(label)
            if status=='matched': counts[f'{split}_{task}_matched']+=1
            else: counts[status]+=1
            rows.append([image,label,g,task,split,status])
        manifest=OUT/'manifest.csv'
        with manifest.open('w',newline='',encoding='utf-8') as f:
            w=csv.writer(f); w.writerow(['image_archive_path','label_archive_path','rover_source','label_task','source_split','pair_status']); w.writerows(rows)
        # Useful explicit lists. Ambiguous and missing entries remain visible in the master manifest.
        for split,name in [('train','train_manifest.csv'),('test','test_manifest.csv')]:
            subset=[r for r in rows if ((split=='train' and r[4] in ('train','train_source_merged_no_test_split')) or (split=='test' and r[4]=='test')) and r[5]=='matched']
            with (OUT/name).open('w',newline='',encoding='utf-8') as f:
                w=csv.writer(f); w.writerow(['image_archive_path','label_archive_path','rover_source','label_task','source_split','pair_status']); w.writerows(subset)
        review=[r for r in rows if r[5]!='matched']
        with (OUT/'pair_review.csv').open('w',newline='',encoding='utf-8') as f:
            w=csv.writer(f); w.writerow(['image_archive_path','label_archive_path','rover_source','label_task','source_split','pair_status']); w.writerows(review)
        print(f'AI4Mars manifest: {len(images):,} images, {len(labels):,} labels; {sum(1 for r in rows if r[5]=="matched"):,} exact pairs; {len(review):,} labels need review.')
        print('Pair statuses:',dict(counts))
        expected=sum(i.file_size for i in z.infolist())
        if EXTRACT.exists():
            print(f'Extracted source already exists; leaving it untouched: {EXTRACT}')
        elif STAGE.exists():
            raise RuntimeError(f'Partial extraction exists: {STAGE}; inspect before continuing.')
        else:
            n,size=safe_extract(z,STAGE)
            STAGE.rename(EXTRACT)
            print(f'AI4Mars extracted: {n:,} files, {size:,} bytes at {EXTRACT}')
    # Repoint manifests to extracted paths for local training.
    for name in ['manifest.csv','train_manifest.csv','test_manifest.csv','pair_review.csv']:
        path=OUT/name
        temp=path.with_suffix('.tmp')
        with path.open('r',newline='',encoding='utf-8') as src, temp.open('w',newline='',encoding='utf-8') as dst:
            reader=csv.reader(src); writer=csv.writer(dst)
            header=next(reader); writer.writerow(['image_path','label_path','rover_source','label_task','source_split','pair_status'])
            for row in reader:
                for j in (0,1):
                    if row[j]: row[j]=(EXTRACT/row[j]).as_posix()
                writer.writerow(row)
        temp.replace(path)

if __name__=='__main__': main()

