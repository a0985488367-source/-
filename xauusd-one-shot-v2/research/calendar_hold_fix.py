import pandas as pd,numpy as np,importlib.util,contextlib,io,json
spec=importlib.util.spec_from_file_location('ev','./exit_variants.py');ev=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):spec.loader.exec_module(ev)
d=ev.d;q=ev.q;qpos=ev.qpos;o=ev.o;hi=ev.hi;lo=ev.lo;cl=ev.cl;sp=ev.sp;atr=ev.atr;times=ev.times;sig=ev.sig

def run(start,end,hours=48,fri='none',cost=1.0):
 start=pd.Timestamp(start,tz='UTC');end=pd.Timestamp(end,tz='UTC');last=-1;rs=[];dur=[];weekend=0
 slip=.05*cost;fee=.07*cost;carry=.30*cost
 for z in np.flatnonzero(sig):
  i=qpos[z]
  if i<0 or i<=last or times[i]<start or times[i]>=end or not np.isfinite(atr[z]):continue
  if fri=='all' and times[i].weekday()==4:continue
  if fri=='late' and times[i].weekday()==4 and times[i].hour>=18:continue
  side=int(sig[z]);dist=2*atr[z];entry=(o[i]+sp[i] if side==1 else o[i])+side*slip;stop=entry-side*dist;target=entry+side*5*dist;pending=None;peak=0;fill=None;j=i
  deadline=times[i]+pd.Timedelta(hours=hours)
  for j in range(i,len(d)):
   if times[j]>=end:j=max(i,j-1);break
   if pending is not None:stop=max(stop,pending) if side==1 else min(stop,pending);pending=None
   # Time exit at first available quote at/after true calendar deadline
   if j>i and times[j]>=deadline:
    fill=(o[j]+(sp[j] if side==-1 else 0))-side*slip;break
   oo=o[j]+(sp[j] if side==-1 else 0);hh=hi[j]+(sp[j] if side==-1 else 0);ll=lo[j]+(sp[j] if side==-1 else 0)
   if side==1:
    if oo<=stop:fill=oo-slip;break
    if oo>=target:fill=target;break
    if ll<=stop:fill=stop-slip;break
    if hh>=target:fill=target;break
   else:
    if oo>=stop:fill=oo+slip;break
    if oo<=target:fill=target;break
    if hh>=stop:fill=stop+slip;break
    if ll<=target:fill=target;break
   exc=side*((cl[j]+(sp[j] if side==-1 else 0))-entry)/dist;peak=max(peak,exc)
   if peak>=1.5:pending=entry
  if fill is None:fill=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
  delta=times[j]-times[i];dur.append(delta.total_seconds()/3600)
  # detect crossing market weekend by calendar: entry weekday Thu/Fri and exit Sun/Mon with >24h
  if delta.total_seconds()>24*3600 and times[i].weekday() in (3,4) and times[j].weekday() in (6,0):weekend+=1
  days=max(0,(times[j].normalize()-times[i].normalize()).days);rs.append((side*(fill-entry)-fee-carry*days)/dist);last=j
 return np.array(rs),np.array(dur),weekend

def st(t):
 r,d,w=t;neg=-r[r<0].sum();return {'n':len(r),'win':float((r>0).mean()),'meanR':float(r.mean()),'pf':float(r[r>0].sum()/neg) if neg else 99,'sumR':float(r.sum()),'max_hours':float(d.max()) if len(d) else 0,'p95_hours':float(np.percentile(d,95)) if len(d) else 0,'weekend_cross':w}
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
out={}
for hours in [24,36,48]:
 for fri in ['none','late','all']:
  key=f'{hours}cal_{fri}';out[key]={k:st(run(a,b,hours,fri)) for k,(a,b) in periods.items()};out[key]['FINAL90_x2']=st(run('2026-06-19','2026-09-17',hours,fri,2))
print(json.dumps(out,indent=2));json.dump(out,open('./calendar_hold_results.json','w'),indent=2)
