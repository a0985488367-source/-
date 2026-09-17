import pandas as pd, numpy as np, json, warnings
warnings.filterwarnings('ignore')
# setup copied compactly from exit_variants by executing before run(); disable numba cache
src=open('./exit_variants.py').read(); prefix=src.split('def run(',1)[0]
ns={}; exec(prefix,ns)
d=ns['d']; q=ns['q']; qpos=ns['qpos']; o=ns['o']; hi=ns['hi']; lo=ns['lo']; cl=ns['cl']; sp=ns['sp']; atr=ns['atr']; sig=ns['sig']; times=d.index

# Each leg weight is relative to initial size. Net R denominator = initial risk distance * initial size.
def run(start,end,targetR=5., add1R=1.5,add1W=1.,add2R=3.,add2W=.5,cost_mult=1.,trail_after=None,trail_atr_mult=None):
    start=pd.Timestamp(start,tz='UTC');end=pd.Timestamp(end,tz='UTC');last=-1;out=[]
    slip=.05*cost_mult; fee=.07*cost_mult; carry=.30*cost_mult
    for z in np.flatnonzero(sig):
        i=qpos[z]
        if i<0 or i<=last or i>=len(d) or times[i]<start or times[i]>=end or not np.isfinite(atr[z]):continue
        side=int(sig[z]);dist=2*atr[z];base_entry=(o[i]+sp[i] if side==1 else o[i])+side*slip; stop=base_entry-side*dist; target=base_entry+side*targetR*dist
        legs=[(base_entry,1.,i)]; pending_stage=0; stages=0; pending_stop=None; fill=None;j=i;deadline=min(len(d),i+576)
        def net_at(price,jj):
            s=0.
            for en,w,ii in legs:
                days=max(0,(times[jj].normalize()-times[ii].normalize()).days)
                s += w*(side*(price-en)-fee-carry*days)
            return s/dist
        for j in range(i,deadline):
            if times[j]>=end: j=max(i,j-1);break
            if pending_stop is not None:
                stop=max(stop,pending_stop) if side==1 else min(stop,pending_stop);pending_stop=None
            # executable side for exits
            oo=o[j]+(sp[j] if side==-1 else 0); hh=hi[j]+(sp[j] if side==-1 else 0); ll=lo[j]+(sp[j] if side==-1 else 0)
            # opening gap vs current stop/target BEFORE add
            if side==1:
                if oo<=stop:fill=oo-slip;break
                if oo>=target:fill=target;break
            else:
                if oo>=stop:fill=oo+slip;break
                if oo<=target:fill=target;break
            # execute pending add at actual open if basket positive and still beyond trigger
            if pending_stage and stages<2:
                mark=oo
                base_exc=side*(mark-base_entry)/dist
                trig=add1R if stages==0 else add2R
                if base_exc>=trig and net_at(mark,j)>0:
                    w=add1W if stages==0 else add2W
                    add_entry=(o[j]+sp[j] if side==1 else o[j])+side*slip
                    legs.append((add_entry,w,j)); stages+=1
                    # Common basket breakeven incl known entry/exit fee approximation and exit slip
                    totalw=sum(x[1] for x in legs); avg=sum(x[0]*x[1] for x in legs)/totalw
                    known=0.
                    for en,ww,ii in legs:
                        days=max(0,(times[j].normalize()-times[ii].normalize()).days)
                        known += ww*(fee+carry*days+slip)
                    be=avg+side*(known/totalw)
                    stop=max(stop,be) if side==1 else min(stop,be)
                pending_stage=0
            # intrabar hit after add
            if side==1:
                if ll<=stop: fill=stop-slip;break
                if hh>=target: fill=target;break
            else:
                if hh>=stop: fill=stop+slip;break
                if ll<=target: fill=target;break
            markc=cl[j]+(sp[j] if side==-1 else 0); exc=side*(markc-base_entry)/dist
            if stages==0 and exc>=add1R: pending_stage=1
            elif stages==1 and exc>=add2R: pending_stage=2
            if trail_after is not None and exc>=trail_after:
                cand=markc-side*trail_atr_mult*atr[z]
                pending_stop=max(stop,cand) if side==1 else min(stop,cand)
        if fill is None:
            fill=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
        r=net_at(fill,j); out.append(r);last=j
    return np.array(out)

def st(r):
 neg=-r[r<0].sum();ml=cur=0
 for x in r:
  if x<=0:cur+=1;ml=max(ml,cur)
  else:cur=0
 return {'n':len(r),'win':float((r>0).mean()),'meanR':float(r.mean()),'pf':float(r[r>0].sum()/neg) if neg>0 else 99,'sumR':float(r.sum()),'maxL':ml,'maxR':float(r.max()) if len(r) else 0}
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
variants={
 'PYR5_05_025':dict(targetR=5,add1R=1.5,add1W=.5,add2R=3,add2W=.25),
 'PYR5_1_05':dict(targetR=5,add1R=1.5,add1W=1,add2R=3,add2W=.5),
 'PYR5_2_1':dict(targetR=5,add1R=1.5,add1W=2,add2R=3,add2W=1),
 'PYR8_1_05':dict(targetR=8,add1R=1.5,add1W=1,add2R=3,add2W=.5),
 'PYR8_late':dict(targetR=8,add1R=2,add1W=1,add2R=4,add2W=.5),
 'PYR_TRAIL':dict(targetR=20,add1R=1.5,add1W=1,add2R=3,add2W=.5,trail_after=5,trail_atr_mult=2),
}
out={}
for name,kw in variants.items():
 out[name]={}
 for k,(a,b) in periods.items():out[name][k]=st(run(a,b,**kw))
 out[name]['FINAL90_x2cost']=st(run('2026-06-19','2026-09-17',cost_mult=2,**kw))
 r=run('2026-06-19','2026-09-17',**kw);out[name]['eq']={}
 for f in [.03,.05,.07,.10,.15,.20,.25,.30]:
  bal=60.;peak=60.;dd=0.;hit=False
  for x in r:
   bal*=max(0,1+f*x);peak=max(peak,bal);dd=max(dd,(peak-bal)/peak);hit=hit or bal>=10000
  out[name]['eq'][str(f)]={'final':float(bal),'dd':float(dd),'hit':bool(hit)}
print(json.dumps(out,indent=2));json.dump(out,open('./pyramid_results.json','w'),indent=2)
