import pandas as pd, numpy as np, importlib.util, contextlib, io, json
# load prefix from exit_variants through its module
spec=importlib.util.spec_from_file_location('ev','./exit_variants.py'); ev=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(ev)
d=ev.d;q=ev.q;qpos=ev.qpos;o=ev.o;hi=ev.hi;lo=ev.lo;cl=ev.cl;sp=ev.sp;atr=ev.atr;times=ev.times;sig=ev.sig

def run(start,end,mode='base',cost_mult=1.0):
 start=pd.Timestamp(start,tz='UTC');end=pd.Timestamp(end,tz='UTC');last=-1;rs=[]
 slip=.05*cost_mult; fee=.07*cost_mult; carry=.30*cost_mult
 for z in np.flatnonzero(sig):
  i=qpos[z]
  if i<0 or i<=last or i>=len(d) or times[i]<start or times[i]>=end or not np.isfinite(atr[z]):continue
  # optional Friday late-entry ban
  if 'banfri' in mode and times[i].weekday()==4 and times[i].hour>=18: continue
  side=int(sig[z]);dist=2*atr[z];entry=(o[i]+sp[i] if side==1 else o[i])+side*slip
  stop=entry-side*dist;target=entry+side*5*dist;pending=None;peakR=0;fill=None;j=i
  for j in range(i,min(len(d),i+576)):
   if times[j]>=end: j=max(i,j-1);break
   if pending is not None:
    stop=max(stop,pending) if side==1 else min(stop,pending);pending=None
   # Friday close before weekend, at available M5 open 20:45 UTC or later in same hour
   if 'friclose' in mode and j>i and times[j].weekday()==4 and (times[j].hour>20 or (times[j].hour==20 and times[j].minute>=45)):
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
   exc=side*((cl[j]+(sp[j] if side==-1 else 0))-entry)/dist;peakR=max(peakR,exc)
   if peakR>=1.5:pending=entry
  if fill is None:
   fill=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
  days=max(0,(times[j].normalize()-times[i].normalize()).days)
  rs.append((side*(fill-entry)-fee-carry*days)/dist);last=j
 return np.array(rs)

def st(r):
 neg=-r[r<0].sum();return {'n':len(r),'win':float((r>0).mean()),'meanR':float(r.mean()),'pf':float(r[r>0].sum()/neg) if neg else 99,'sumR':float(r.sum())}
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
out={}
for mode in ['base','friclose','banfri','banfri_friclose']:
 out[mode]={k:st(run(a,b,mode)) for k,(a,b) in periods.items()}
 out[mode]['FINAL90_x2']=st(run('2026-06-19','2026-09-17',mode,2.0))
print(json.dumps(out,indent=2));json.dump(out,open('./gap_guard_results.json','w'),indent=2)
