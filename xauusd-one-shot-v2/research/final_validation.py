import pandas as pd, numpy as np, json, math, warnings
from numba import njit
warnings.filterwarnings('ignore')
P='./data/XAUUSD_M5.csv.gz'
d=pd.read_csv(P); d['time']=pd.to_datetime(d.time,utc=True); d=d.set_index('time').sort_index()
q=d.resample('15min',label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last'),spread=('spread','median')).dropna()
prev=q.close.shift(); tr=pd.concat([q.high-q.low,(q.high-prev).abs(),(q.low-prev).abs()],axis=1).max(axis=1); q['atr']=tr.ewm(alpha=1/14,adjust=False,min_periods=14).mean()
lo32=q.low.shift(1).rolling(32).min(); hi32=q.high.shift(1).rolling(32).max(); q['pos32']=(q.close-lo32)/(hi32-lo32); q['atrrel']=q.atr/q.atr.shift().rolling(50).mean(); q['body']=(q.close-q.open)/q.atr
for rule,prefix in [('1h','h1'),('4h','h4')]:
 h=d.resample(rule,label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last')).dropna(); hp=h.close.shift(); ht=pd.concat([h.high-h.low,(h.high-hp).abs(),(h.low-hp).abs()],axis=1).max(axis=1).ewm(alpha=1/14,adjust=False,min_periods=14).mean(); e20=h.close.ewm(span=20,adjust=False,min_periods=20).mean(); e50=h.close.ewm(span=50,adjust=False,min_periods=50).mean(); e200=h.close.ewm(span=200,adjust=False,min_periods=200).mean(); h['trend']=(e20-e50)/ht; h['macro']=(e50-e200)/ht; h.index=h.index+pd.Timedelta(rule); dec=q.index+pd.Timedelta(minutes=15)
 for c in ['trend','macro']: q[f'{prefix}_{c}']=h[c].reindex(dec,method='ffill').to_numpy()
q['hour']=(q.index+pd.Timedelta(minutes=15)).hour
qpos=d.index.get_indexer(q.index+pd.Timedelta(minutes=15)).astype(np.int64)
o=d.open.to_numpy(float); hi=d.high.to_numpy(float); lo=d.low.to_numpy(float); cl=d.close.to_numpy(float); sp=d.spread.to_numpy(float); atr=q.atr.to_numpy(float); times_ns=d.index.asi8*{'s':10**9,'ms':10**6,'us':10**3,'ns':1}[d.index.unit]  # asi8 的單位隨 pandas 版本而異（2.x=ns、3.x=us），ns() 用的 Timestamp.value 恆為 ns，不換算會讓所有時間比較失效且靜默回傳 0 筆
@njit(cache=True)
def bt(sig,qpos,atr,o,hi,lo,cl,sp,times_ns,start_ns,end_ns,stopk,rr,cost_mult,return_trades=False):
    maxn=len(sig); rs=np.empty(maxn); exits=np.empty(maxn,np.int64); entries=np.empty(maxn,np.int64); sides=np.empty(maxn,np.int8); n=0; last_exit=-1
    slip=.05*cost_mult; fee=.07*cost_mult; carry=.30*cost_mult
    day_ns=86400_000_000_000
    for z in range(maxn):
        side=sig[z]
        if side==0: continue
        i=qpos[z]
        if i<0 or i<=last_exit or i>=len(o): continue
        if times_ns[i]<start_ns or times_ns[i]>=end_ns or not np.isfinite(atr[z]): continue
        dist=stopk*atr[z]
        if dist<=0: continue
        entry=(o[i]+(sp[i] if side==1 else 0.0))+side*slip
        stop=entry-side*dist; tp=entry+side*rr*dist
        endj=min(len(o)-1,i+287); fill=np.nan; j=endj
        for jj in range(i,endj+1):
            if times_ns[jj]>=end_ns:
                j=max(i,jj-1); break
            j=jj
            oo=o[j]+(sp[j] if side==-1 else 0.0); hh=hi[j]+(sp[j] if side==-1 else 0.0); ll=lo[j]+(sp[j] if side==-1 else 0.0)
            if side==1:
                if oo<=stop: fill=oo-slip; break
                if oo>=tp: fill=tp; break
                if ll<=stop: fill=stop-slip; break
                if hh>=tp: fill=tp; break
            else:
                if oo>=stop: fill=oo+slip; break
                if oo<=tp: fill=tp; break
                if hh>=stop: fill=stop+slip; break
                if ll<=tp: fill=tp; break
        if not np.isfinite(fill):
            fill=(cl[j]+(sp[j] if side==-1 else 0.0))-side*slip
        carrydays=max(0,(times_ns[j]//day_ns)-(times_ns[i]//day_ns))
        r=(side*(fill-entry)-fee-carry*carrydays)/dist
        rs[n]=r; exits[n]=j; entries[n]=i; sides[n]=side; n+=1; last_exit=j
    return rs[:n],entries[:n],exits[:n],sides[:n]

def stats(r):
    if len(r)==0:return {'n':0,'meanR':None,'pf':None,'win':None,'sumR':0}
    neg=-r[r<0].sum();
    # max losing streak
    ml=cur=0
    for x in r:
        if x<=0: cur+=1; ml=max(ml,cur)
        else: cur=0
    return {'n':int(len(r)),'meanR':float(r.mean()),'pf':float(r[r>0].sum()/neg) if neg>0 else 99.,'win':float((r>0).mean()),'sumR':float(r.sum()),'maxL':int(ml)}

def sig_for(h4=1.0,h1=.25,pos=.7,body=.3,atrlo=.8,atrhi=1.8,h0=12,h1hour=21):
    L=(q.h4_macro>h4)&(q.h1_trend>h1)&(q.pos32>pos)&(q.body>body)&q.atrrel.between(atrlo,atrhi)&q.hour.between(h0,h1hour)
    S=(q.h4_macro<-h4)&(q.h1_trend<-h1)&(q.pos32<(1-pos))&(q.body<-body)&q.atrrel.between(atrlo,atrhi)&q.hour.between(h0,h1hour)
    return np.where(L,1,np.where(S,-1,0)).astype(np.int8)
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
def ns(s): return pd.Timestamp(s,tz='UTC').value
locked=sig_for(); out={'locked':{}}
allr=[]
for k,(a,b) in periods.items():
 r,en,ex,sd=bt(locked,qpos,atr,o,hi,lo,cl,sp,times_ns,ns(a),ns(b),2.,3.,1.)
 out['locked'][k]=stats(r); allr.append(r)
# cost stress
for mult in [1.5,2,3]:
 r,*_=bt(locked,qpos,atr,o,hi,lo,cl,sp,times_ns,ns('2026-06-19'),ns('2026-09-17'),2.,3.,mult)
 out['locked'][f'FINAL90_costx{mult}']=stats(r)
# parameter neighborhood fixed around locked candidate; no reselection
neigh=[]
for h4 in [.75,1.0,1.25]:
 for h1v in [0,.25,.5]:
  for pc in [.65,.7,.75]:
   for bd in [.2,.3,.4]:
    s=sig_for(h4,h1v,pc,bd)
    rec={'p':[h4,h1v,pc,bd]}
    for k,(a,b) in periods.items():
     r,*_=bt(s,qpos,atr,o,hi,lo,cl,sp,times_ns,ns(a),ns(b),2.,3.,1.); rec[k]=stats(r)
    neigh.append(rec)
out['neighborhood']={
 'total':len(neigh),
 'positive_all4':sum(all(x[k]['meanR'] is not None and x[k]['meanR']>0 for k in periods) for x in neigh),
 'final90_positive':sum(x['FINAL90']['meanR'] is not None and x['FINAL90']['meanR']>0 for x in neigh),
 'final90_pf_gt1_1':sum(x['FINAL90']['pf'] is not None and x['FINAL90']['pf']>1.1 for x in neigh),
 'final90_meanR_median':float(np.median([x['FINAL90']['meanR'] for x in neigh if x['FINAL90']['meanR'] is not None])),
 'final90_pf_median':float(np.median([x['FINAL90']['pf'] for x in neigh if x['FINAL90']['pf'] is not None]))
}
# Monte Carlo block bootstrap of all sequential historical locked trades, 40 trades per 90d
pool=np.concatenate(allr); rng=np.random.default_rng(20260917); nmc=10000; N=40; block=5
risks=[.03,.05,.07,.10,.15,.20,.25,.30]; mc={}
for f in risks:
 finals=np.empty(nmc); dds=np.empty(nmc); hits=np.zeros(nmc,bool)
 for m in range(nmc):
  seq=[]
  while len(seq)<N:
   st=rng.integers(0,max(1,len(pool)-block+1)); seq.extend(pool[st:st+block].tolist())
  seq=np.array(seq[:N]); bal=60.; peak=60.; dd=0.; hit=False
  for r in seq:
   bal*=max(0.,1+f*r); peak=max(peak,bal); dd=max(dd,(peak-bal)/peak if peak else 1); hit |= bal>=10000
  finals[m]=bal; dds[m]=dd; hits[m]=hit
 mc[str(f)]={'median':float(np.median(finals)),'p5':float(np.percentile(finals,5)),'p95':float(np.percentile(finals,95)),'dd_med':float(np.median(dds)),'dd_p95':float(np.percentile(dds,95)),'hit10000':float(hits.mean()),'under5':float((finals<=5).mean())}
out['monte_carlo_90d_40trades']=mc
# actual final equity
r,*_=bt(locked,qpos,atr,o,hi,lo,cl,sp,times_ns,ns('2026-06-19'),ns('2026-09-17'),2.,3.,1.)
eq={}
for f in risks:
 bal=60.;peak=60.;dd=0;hit=False
 for x in r:
  bal*=max(0,1+f*x);peak=max(peak,bal);dd=max(dd,(peak-bal)/peak);hit |= bal>=10000
 eq[str(f)]={'final':bal,'maxDD':dd,'hit10000':bool(hit)}
out['actual_FINAL90_equity']=eq
print(json.dumps(out,indent=2)); json.dump(out,open('./final_validation_results.json','w'),indent=2)
