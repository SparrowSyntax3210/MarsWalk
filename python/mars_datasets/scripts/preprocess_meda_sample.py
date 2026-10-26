from pathlib import Path
import pandas as pd
ROOT=Path(__file__).resolve().parent.parent
SRC=ROOT/'data/raw/weather/meda/sample_sol_0001'
OUT=ROOT/'data/processed/climate'
FILES={
 'ps':'WE__0001___________DER_PS__________________P02.CSV',
 'rhs':'WE__0001___________DER_RHS_________________P03.CSV',
 'tirs':'WE__0001___________DER_TIRS________________P04.CSV',
 'ancillary':'WE__0001___________DER_ANCILLARY___________P03.CSV'}

def main():
 tables={}
 for name,file in FILES.items():
  p=SRC/file
  if not p.exists(): raise FileNotFoundError(p)
  df=pd.read_csv(p,low_memory=False)
  df.columns=[c.strip().lower() for c in df.columns]
  if 'sclk' not in df: raise ValueError(f'{p.name} has no SCLK field')
  df['sclk']=pd.to_numeric(df['sclk'],errors='coerce')
  df=df.dropna(subset=['sclk']).sort_values('sclk').drop_duplicates('sclk')
  df['sclk']=df['sclk'].astype('int64')
  df=df.rename(columns={c:f'{name}_{c}' for c in df.columns if c not in {'sclk','lmst','ltst'}})
  for t in ('lmst','ltst'):
   if t in df:
    df=df.rename(columns={t:f'{name}_{t}'})
  tables[name]=df
 clock=pd.DataFrame({'sclk':sorted(set().union(*(set(t['sclk'].astype('int64')) for t in tables.values())))})
 clock['sclk']=clock['sclk'].astype('int64')
 merged=clock
 for name,df in tables.items():
  merged=pd.merge_asof(merged,df.sort_values('sclk'),on='sclk',direction='nearest',tolerance=2)
 merged.insert(0,'mission','Mars2020_Perseverance')
 merged.insert(1,'sol',1)
 merged['source_location']='Jezero rover observation; per-record rover coordinates require PDS ancillary/SPICE reconstruction'
 merged['join_method']='nearest spacecraft-clock tick within 2 seconds; preserve source time columns'
 OUT.mkdir(parents=True,exist_ok=True)
 out=OUT/'meda_sol0001_environment_merged.csv'
 merged.to_csv(out,index=False,na_rep='')
 summary=OUT/'meda_sol0001_environment_summary.csv'
 numeric=merged.select_dtypes(include='number')
 rows=[]
 for col in merged.columns:
  if col in {'sclk','sol'}: continue
  series=pd.to_numeric(merged[col],errors='coerce')
  if series.notna().any():
   rows.append({'column':col,'n_non_null':int(series.notna().sum()),'minimum':series.min(),'maximum':series.max(),'mean':series.mean()})
 pd.DataFrame(rows).to_csv(summary,index=False)
 print(f'Rows: {len(merged):,}; columns: {len(merged.columns):,}; merged CSV: {out}')
 print(f'Summary CSV: {summary}; sources: {list(FILES)}')
 print('This is one local rover sol, not global Mars climate coverage.')
if __name__=='__main__': main()

