from __future__ import annotations
import argparse, json
from pathlib import Path
import numpy as np
import netCDF4

ROOT=Path(__file__).resolve().parent.parent
MCD_DATA=ROOT/'data'/'processed'/'climate'/'mcd_6.2_bundle'/'MCD_6.2'/'data'
SCENARIO_CODES={1:'clim_aveEUV',2:'clim_minEUV',3:'clim_maxEUV',4:'strm_min',5:'strm_ave',6:'strm_max',7:'warm',8:'cold'}
SURFACE_VARS=('tsurf','ps','tau_pref_gcm','col_h2ovapor','col_h2oice','fluxsurf_dn_sw','fluxsurf_lw')
ATMOS_VARS=('temp','u','v','rho')
UNITS={'tsurf':'K','ps':'Pa','tau_pref_gcm':'NU','col_h2ovapor':'kg/m2','col_h2oice':'kg/m2',
       'fluxsurf_dn_sw':'W/m2','fluxsurf_lw':'W/m2','temp':'K','u':'m/s','v':'m/s','rho':'kg/m3'}

def scenario_name(scenario):
    try: n=int(scenario)
    except (TypeError,ValueError):
        name=str(scenario)
        return 'strm_ave' if name=='strm' else name
    if n in SCENARIO_CODES: return SCENARIO_CODES[n]
    if 24<=n<=37: return f'MY{n}'
    raise ValueError(f'Unsupported MCD scenario {scenario!r}; use 1-8, 24-37, an installed scenario, or strm_min/strm_ave/strm_max.')

def season_bracket(ls):
    if not np.isfinite(ls) or ls<0 or ls>360: raise ValueError('Ls must be between 0 and 360 degrees.')
    position=((float(ls)%360.0)-15.0)/30.0
    lower=int(np.floor(position))%12
    weight=position-np.floor(position)
    return lower+1,(lower+1)%12+1,float(weight)

def _cyclic_bracket(axis, values, period):
    axis=np.asarray(axis,dtype=float); values=np.asarray(values,dtype=float)
    if len(axis)<2: raise ValueError('Coordinate axis needs at least two points.')
    step=float(axis[1]-axis[0]); pos=np.mod(values-axis[0],period)/step
    lo=np.floor(pos).astype(np.int64)%len(axis); frac=pos-np.floor(pos)
    return lo,(lo+1)%len(axis),frac

def _linear_bracket(axis, values):
    axis=np.asarray(axis,dtype=float); values=np.asarray(values,dtype=float)
    if axis[0]>axis[-1]:
        asc=axis[::-1]; q=np.clip(values,asc[0],asc[-1]); hi=np.searchsorted(asc,q,side='right')
        hi=np.clip(hi,1,len(asc)-1); lo=hi-1
        i0=len(axis)-1-lo; i1=len(axis)-1-hi
    else:
        q=np.clip(values,axis[0],axis[-1]); hi=np.searchsorted(axis,q,side='right')
        hi=np.clip(hi,1,len(axis)-1); lo=hi-1; i0=lo; i1=hi
    den=axis[i1]-axis[i0]; frac=np.divide(q-axis[i0],den,out=np.zeros_like(q,dtype=float),where=den!=0)
    return i0.astype(np.int64),i1.astype(np.int64),frac

class MCDSampler:
    """Interpolates MCD mean NetCDF grids, including separate thermosphere EUV files."""
    def __init__(self,data_dir:Path|str=MCD_DATA,scenario=1):
        self.data_dir=Path(data_dir); self.scenario=scenario_name(scenario)
        self.data_scenario='strm' if self.scenario.startswith('strm_') else self.scenario
        # EUV min/max climatology packages provide thermosphere files only;
        # their lower-atmosphere and surface fields are from clim_aveEUV.
        self.lower_scenario='clim_aveEUV' if self.data_scenario in {'clim_minEUV','clim_maxEUV'} else self.data_scenario
        self.folder=self.data_dir/self.data_scenario
        self.lower_folder=self.data_dir/self.lower_scenario
        self.prefix='clim' if self.lower_scenario.startswith('clim_') else self.lower_scenario
        self.thermo_prefix='clim' if self.data_scenario.startswith('clim_') else self.data_scenario
        self.thermo_euv={
            'clim_aveEUV':'ave','clim_minEUV':'min','clim_maxEUV':'max',
            'cold':'min','warm':'max','strm_min':'min','strm_ave':'ave','strm_max':'max'
        }.get(self.scenario, 'ave')
        for folder in {self.folder,self.lower_folder}:
            if not folder.is_dir():
                available=sorted(p.name for p in self.data_dir.iterdir() if p.is_dir()) if self.data_dir.exists() else []
                raise FileNotFoundError(f'MCD scenario {self.scenario!r} is not installed under {self.data_dir}. Available: {available}')
        self._coord_cache={}

    def available_scenarios(self):
        installed=sorted(p.name for p in self.data_dir.iterdir() if p.is_dir())
        return sorted(set(installed+['strm_min','strm_ave','strm_max']))

    def _file(self,month):
        p=self.lower_folder/f'{self.prefix}_{month:02d}_me.nc'
        if not p.is_file(): raise FileNotFoundError(f'Missing MCD lower-atmosphere mean file: {p}')
        return p

    def _thermo_file(self,month):
        p=self.folder/f'{self.thermo_prefix}_{month:02d}_thermo_{self.thermo_euv}_me.nc'
        if not p.is_file(): raise FileNotFoundError(f'Missing MCD {self.thermo_euv}-EUV thermosphere file: {p}')
        return p

    def _coords(self,path):
        key=str(path)
        if key not in self._coord_cache:
            with netCDF4.Dataset(path) as ds:
                self._coord_cache[key]={k:np.asarray(ds.variables[k][:],dtype=float) for k in ('Time','latitude','longitude','altitude')}
                self._coord_cache[key]['time_units']=getattr(ds.variables['Time'],'units','')
        return self._coord_cache[key]

    @staticmethod
    def _weighted_sample(field, dims, coords, lat, lon, local_time, altitude_km):
        n=len(lat); ones=np.ones(n)
        ti0,ti1,tw=_cyclic_bracket(coords['Time'],local_time,24.0)
        la0,la1,law=_linear_bracket(coords['latitude'],lat)
        lo0,lo1,low=_cyclic_bracket(coords['longitude'],lon,360.0)
        brackets=[((ti0,1-tw),(ti1,tw)),((la0,1-law),(la1,law)),((lo0,1-low),(lo1,low))]
        if len(dims)==4:
            al0,al1,alw=_linear_bracket(coords['altitude'],np.full(n,altitude_km))
            brackets.insert(1,((al0,1-alw),(al1,alw)))
        out=np.zeros(n,dtype=np.float64); valid_weight=np.zeros(n,dtype=np.float64)
        for choices in __import__('itertools').product((0,1),repeat=len(brackets)):
            ix=[]; weight=ones.copy()
            for axis,choice in enumerate(choices):
                indices,weights=brackets[axis][choice]
                ix.append(indices); weight*=weights
            vals=np.asarray(field[tuple(ix)],dtype=np.float64)
            valid=np.isfinite(vals); out+=np.where(valid,vals*weight,0.0); valid_weight+=np.where(valid,weight,0.0)
        return np.divide(out,valid_weight,out=np.full(n,np.nan),where=valid_weight>0)

    def sample_many(self,latitudes,longitudes,ls,local_time,altitude_km=0.00448064,variables=None):
        lat=np.asarray(latitudes,dtype=float).reshape(-1); lon=np.asarray(longitudes,dtype=float).reshape(-1)
        if lat.shape!=lon.shape: raise ValueError('Latitude and longitude arrays must have the same shape.')
        if np.any(~np.isfinite(lat)) or np.any((lat<-90)|(lat>90)): raise ValueError('Latitude must be finite and between -90 and 90.')
        if np.any(~np.isfinite(lon)): raise ValueError('Longitude must be finite.')
        if not 0<=float(local_time)<=24: raise ValueError('Local true solar time must be 0 to 24 Martian hours.')
        if not np.isfinite(altitude_km): raise ValueError('Altitude coordinate must be finite km.')
        if self.scenario.startswith('strm_') and float(ls)<180: raise ValueError('MCD dust-storm scenario is only defined for Ls 180 to 360 degrees.')
        lon=((lon+180)%360)-180
        variables=tuple(variables or (SURFACE_VARS+ATMOS_VARS))
        m0,m1,season_weight=season_bracket(float(ls)); months=[(m0,1-season_weight)]
        if m1!=m0 and season_weight>0: months.append((m1,season_weight))
        out={}; units={}; altitude_clamped=False; altitude_sources=set()
        for name in variables:
            season_values=[]; unit=None
            for month,_ in months:
                lower_path=self._file(month); path=lower_path
                if name in ATMOS_VARS:
                    lower_coords=self._coords(lower_path)
                    lower_top=float(np.max(lower_coords['altitude']))
                    if float(altitude_km)>lower_top:
                        thermo_path=self._thermo_file(month); thermo_coords=self._coords(thermo_path)
                        thermo_bottom=float(np.min(thermo_coords['altitude']))
                        if float(altitude_km)<thermo_bottom:
                            raise ValueError(f'Altitude {altitude_km:g} km falls in the MCD lower/thermosphere gap ({lower_top:g}..{thermo_bottom:g} km); use the compiled official MCD interface for this transition.')
                        path=thermo_path; altitude_sources.add('thermosphere')
                    else: altitude_sources.add('lower_atmosphere')
                else: altitude_sources.add('surface/lower_atmosphere')
                coords=self._coords(path)
                with netCDF4.Dataset(path) as ds:
                    if name not in ds.variables: raise KeyError(f'Variable {name!r} not found in {path.name}')
                    var=ds.variables[name]; dims=var.dimensions
                    if dims not in (('Time','latitude','longitude'),('Time','altitude','latitude','longitude')):
                        raise ValueError(f'Unsupported MCD dimensions for {name}: {dims}')
                    unit=getattr(var,'units',UNITS.get(name,''))
                    if 'altitude' in dims:
                        z=coords['altitude']; altitude_clamped |= altitude_km<z.min() or altitude_km>z.max()
                    raw=var[:]
                    if np.ma.isMaskedArray(raw): raw=raw.filled(np.nan)
                    field=np.asarray(raw,dtype=np.float32)
                    season_values.append(self._weighted_sample(field,dims,coords,lat,lon,
                        np.full(len(lat),float(local_time)),float(altitude_km)))
            value=season_values[0] if len(season_values)==1 else season_values[0]*(1-season_weight)+season_values[1]*season_weight
            out[name]=value; units[name]=unit or UNITS.get(name,'')
        if 'u' in out and 'v' in out:
            out['wind_speed']=np.hypot(out['u'],out['v']); units['wind_speed']='m/s'
        meta={'scenario':self.scenario,'lower_atmosphere_scenario':self.lower_scenario,
              'thermosphere_euv_case':self.thermo_euv,'altitude_sources':sorted(altitude_sources),
              'scenario_statistic':'mean','ls_deg':float(ls),
              'local_true_solar_time_hours':float(local_time),'mcd_altitude_coordinate_km':float(altitude_km),
              'altitude_clamped_to_grid':bool(altitude_clamped),'seasonal_months':[m for m,_ in months],
              'seasonal_upper_weight':float(season_weight),'grid_resolution':'MCD native GCM grid; typically 5.625 deg longitude x 3.75 deg latitude'}
        return out,units,meta

    def query(self,latitude,longitude,ls,local_time,altitude_km=0.00448064,variables=None):
        vals,units,meta=self.sample_many([latitude],[longitude],ls,local_time,altitude_km,variables)
        return {'metadata':meta,'values':{k:{'value':float(v[0]),'units':units[k]} for k,v in vals.items()}}

def main():
    ap=argparse.ArgumentParser(description='Query the installed Mars Climate Database mean fields.')
    ap.add_argument('--lat',type=float); ap.add_argument('--lon',type=float); ap.add_argument('--ls',type=float)
    ap.add_argument('--local-time',type=float); ap.add_argument('--altitude-km',type=float,default=0.00448064)
    ap.add_argument('--scenario',default='1',help='MCD scenario code (1-8, 24-37) or installed folder name; for storms use strm_min, strm_ave, or strm_max; defaults to 1 / clim_aveEUV.')
    ap.add_argument('--data-dir',type=Path,default=MCD_DATA); ap.add_argument('--list-scenarios',action='store_true')
    args=ap.parse_args(); sampler=MCDSampler(args.data_dir,args.scenario)
    if args.list_scenarios:
        print(json.dumps(sampler.available_scenarios(),indent=2)); return
    if None in (args.lat,args.lon,args.ls,args.local_time): ap.error('Specify --lat, --lon, --ls, and --local-time (or use --list-scenarios).')
    print(json.dumps(sampler.query(args.lat,args.lon,args.ls,args.local_time,args.altitude_km),indent=2))
if __name__=='__main__': main()



