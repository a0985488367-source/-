import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings('ignore')
# import prepared feature objects by executing safe setup portion from final_validation until periods
src=open('/mnt/data/xau_one_shot_work/final_validation.py').read(); prefix=src.split("periods={'2024'",1)[0].replace('@njit(cache=True)','@njit(cache=False)')
ns={}; exec(prefix,ns)
d=ns['d']; q=ns['q']; qpos=ns['qpos']; o=ns['o']; hi=ns['hi']; lo=ns['lo']; cl=ns['cl']; sp=ns['sp']; atr=ns['atr']; times_ns=ns['times_ns']; sig=ns['sig_for'](); times=d.index

def run(start,end,var,cost_mult=1.0):
    start=pd.Timestamp(start,tz='UTC'); end=pd.Timestamp(end,tz='UTC'); last=-1; rs=[]
    slip=.05*cost_mult; fee=.07*cost_mult; carry=.30*cost_mult
    for z in np.flatnonzero(sig):
        i=qpos[z]
        if i<0 or i<=last or i>=len(d) or times[i]<start or times[i]>=end or not np.isfinite(atr[z]): continue
        side=int(sig[z]); dist=2*atr[z]; entry=(o[i]+sp[i] if side==1 else o[i])+side*slip
        stop=entry-side*dist; pending=None; target=(entry+side*3*dist) if var=='TP3' else (entry+side*5*dist if var in ['BE2_TP5','BE15_TP5'] else np.inf*side)
        deadline=i+576 # 48h for runners, 24h baseline below
        if var=='TP3': deadline=i+288
        j=i; fill=None; peakR=0
        for j in range(i,min(len(d),deadline)):
            if times[j]>=end: j=max(i,j-1); break
            if pending is not None:
                stop=max(stop,pending) if side==1 else min(stop,pending); pending=None
            oo=o[j]+(sp[j] if side==-1 else 0); hh=hi[j]+(sp[j] if side==-1 else 0); ll=lo[j]+(sp[j] if side==-1 else 0)
            if side==1:
                if oo<=stop: fill=oo-slip; break
                if np.isfinite(target) and oo>=target: fill=target; break
                if ll<=stop: fill=stop-slip; break
                if np.isfinite(target) and hh>=target: fill=target; break
            else:
                if oo>=stop: fill=oo+slip; break
                if np.isfinite(target) and oo<=target: fill=target; break
                if hh>=stop: fill=stop+slip; break
                if np.isfinite(target) and ll<=target: fill=target; break
            # management after bar close, effective next bar
            exc=side*((cl[j]+(sp[j] if side==-1 else 0))-entry)/dist
            peakR=max(peakR,exc)
            if var=='BE2_TP5' and peakR>=2: pending=entry
            elif var=='BE15_TP5' and peakR>=1.5: pending=entry
            elif var=='TRAIL3_2ATR' and peakR>=3:
                cand=(cl[j]+(sp[j] if side==-1 else 0))-side*2*atr[z]
                pending=max(stop,cand) if side==1 else min(stop,cand)
            elif var=='TRAIL2_15ATR' and peakR>=2:
                cand=(cl[j]+(sp[j] if side==-1 else 0))-side*1.5*atr[z]
                pending=max(stop,cand) if side==1 else min(stop,cand)
        if fill is None:
            j=min(j,len(d)-1); fill=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
        days=max(0,(times[j].normalize()-times[i].normalize()).days)
        r=(side*(fill-entry)-fee-carry*days)/dist; rs.append(r); last=j
    return np.array(rs)

def st(r):
    neg=-r[r<0].sum(); ml=cur=0
    for x in r:
        if x<=0:cur+=1;ml=max(ml,cur)
        else:cur=0
    return {'n':len(r),'win':float((r>0).mean()),'meanR':float(r.mean()),'pf':float(r[r>0].sum()/neg) if neg>0 else 99,'sumR':float(r.sum()),'maxL':ml}
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
vars=['TP3','BE2_TP5','BE15_TP5','TRAIL3_2ATR','TRAIL2_15ATR']
out={}
for v in vars:
 out[v]={}
 for k,(a,b) in periods.items(): out[v][k]=st(run(a,b,v))
 out[v]['FINAL90_x2cost']=st(run('2026-06-19','2026-09-17',v,2))
 # equity risks final90
 r=run('2026-06-19','2026-09-17',v); out[v]['eq']={}
 for f in [.03,.05,.07,.10,.15,.20,.25,.30]:
  bal=60.;peak=60.;dd=0.;hit=False
  for x in r:
   bal*=max(0,1+f*x); peak=max(peak,bal); dd=max(dd,(peak-bal)/peak); hit=hit or bal>=10000
  out[v]['eq'][str(f)]={'final':bal,'dd':dd,'hit':bool(hit)}
print(json.dumps(out,indent=2)); json.dump(out,open('/mnt/data/xau_one_shot_work/exit_variant_results.json','w'),indent=2)
