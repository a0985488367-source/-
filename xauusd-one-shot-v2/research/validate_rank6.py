# Reuse feature construction from rule_scan without executing its scan by exec prefix
import pandas as pd, numpy as np, json
P='/mnt/data/xau_one_shot_work/data/XAUUSD_M5.csv.gz'
d=pd.read_csv(P); d['time']=pd.to_datetime(d.time,utc=True); d=d.set_index('time').sort_index()
q=d.resample('15min',label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last'),spread=('spread','median')).dropna()
prev=q.close.shift(); tr=pd.concat([q.high-q.low,(q.high-prev).abs(),(q.low-prev).abs()],axis=1).max(axis=1); q['atr']=tr.ewm(alpha=1/14,adjust=False,min_periods=14).mean()
for n in [20,50,200]: q[f'ema{n}']=q.close.ewm(span=n,adjust=False,min_periods=n).mean()
lo32=q.low.shift(1).rolling(32).min(); hi32=q.high.shift(1).rolling(32).max(); q['pos32']=(q.close-lo32)/(hi32-lo32); q['atrrel']=q.atr/q.atr.shift().rolling(50).mean(); q['body']=(q.close-q.open)/q.atr
for rule,prefix in [('1h','h1'),('4h','h4')]:
 h=d.resample(rule,label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last')).dropna(); hp=h.close.shift(); ht=pd.concat([h.high-h.low,(h.high-hp).abs(),(h.low-hp).abs()],axis=1).max(axis=1).ewm(alpha=1/14,adjust=False,min_periods=14).mean(); e20=h.close.ewm(span=20,adjust=False,min_periods=20).mean(); e50=h.close.ewm(span=50,adjust=False,min_periods=50).mean(); e200=h.close.ewm(span=200,adjust=False,min_periods=200).mean(); h['trend']=(e20-e50)/ht; h['macro']=(e50-e200)/ht; h.index=h.index+pd.Timedelta(rule); dec=q.index+pd.Timedelta(minutes=15)
 for c in ['trend','macro']: q[f'{prefix}_{c}']=h[c].reindex(dec,method='ffill').to_numpy()
q['hour']=(q.index+pd.Timedelta(minutes=15)).hour
L=(q.h4_macro>1.0)&(q.h1_trend>0.25)&(q.pos32>0.7)&(q.body>0.3)&q.atrrel.between(.8,1.8)&q.hour.between(12,21)
S=(q.h4_macro<-1.0)&(q.h1_trend<-0.25)&(q.pos32<0.3)&(q.body<-0.3)&q.atrrel.between(.8,1.8)&q.hour.between(12,21)
sig=np.where(L,1,np.where(S,-1,0))
dec=q.index+pd.Timedelta(minutes=15); qpos=d.index.get_indexer(dec)
o=d.open.to_numpy(float); hi=d.high.to_numpy(float); lo=d.low.to_numpy(float); cl=d.close.to_numpy(float); sp=d.spread.to_numpy(float); times=d.index

def backtest(start,end,cost_mult=1.0):
 start=pd.Timestamp(start,tz='UTC'); end=pd.Timestamp(end,tz='UTC'); trades=[]; last_exit=-1
 for z in np.flatnonzero(sig):
  i=qpos[z]
  if i<0 or i<=last_exit or i>=len(d) or times[i]<start or times[i]>=end: continue
  side=int(sig[z]); atr=float(q.atr.iloc[z]);
  if not np.isfinite(atr): continue
  slip=.05*cost_mult; fee=.07*cost_mult; carry=.30*cost_mult; dist=2.0*atr
  entry=(o[i]+sp[i] if side==1 else o[i])+side*slip; stop=entry-side*dist; tp=entry+side*3*dist
  endj=min(len(d)-1,i+288-1); fill=None; reason='TIME'; j=endj
  for j in range(i,endj+1):
   if times[j]>=end: j-=1; break
   oo=o[j]+(sp[j] if side==-1 else 0); hh=hi[j]+(sp[j] if side==-1 else 0); ll=lo[j]+(sp[j] if side==-1 else 0)
   if side==1:
    if oo<=stop: fill=oo-slip; reason='SL_GAP'; break
    if oo>=tp: fill=tp; reason='TP'; break
    if ll<=stop: fill=stop-slip; reason='SL'; break
    if hh>=tp: fill=tp; reason='TP'; break
   else:
    if oo>=stop: fill=oo+slip; reason='SL_GAP'; break
    if oo<=tp: fill=tp; reason='TP'; break
    if hh>=stop: fill=stop+slip; reason='SL'; break
    if ll<=tp: fill=tp; reason='TP'; break
  if fill is None:
   j=max(i,min(j,endj)); fill=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
  midnights=max(0,(times[j].normalize()-times[i].normalize()).days)
  net=(side*(fill-entry)-fee-carry*midnights)/dist
  trades.append({'signal':str(q.index[z]),'entry':str(times[i]),'exit':str(times[j]),'side':side,'net_r':net,'reason':reason,'carry_days':midnights})
  last_exit=j
 return pd.DataFrame(trades)

def st(t):
 if len(t)==0:return {}
 r=t.net_r.to_numpy(); neg=-r[r<0].sum(); return {'n':len(r),'win':float((r>0).mean()),'meanR':float(r.mean()),'sumR':float(r.sum()),'pf':float(r[r>0].sum()/neg) if neg>0 else 99,'maxL':int(max([len(x) for x in ''.join('L' if v<=0 else 'W' for v in r).split('W')]))}
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
out={}
for k,(a,b) in periods.items():
 t=backtest(a,b); out[k]=st(t); t.to_csv(f'/mnt/data/xau_one_shot_work/rank6_{k}_trades.csv',index=False)
# cost double final
out['FINAL90_double_cost']=st(backtest('2026-06-19','2026-09-17',2.0))
# equity compounding on final / 2026 all for risk fractions, non-overlap trades
def eqstats(t,risk):
 bal=60.; peak=bal; dd=0.; hit=False
 for x in t.net_r:
  bal*=max(0,1+risk*x); peak=max(peak,bal); dd=max(dd,(peak-bal)/peak if peak else 1); hit=hit or bal>=10000
 return {'final':bal,'maxDD':dd,'hit10000':hit}
for k,(a,b) in {'FINAL90':periods['FINAL90'],'2026ALL':('2026-01-01','2026-09-17')}.items():
 t=backtest(a,b); out[k+'_equity']={str(r):eqstats(t,r) for r in [.03,.05,.07,.10,.15,.20]}
print(json.dumps(out,indent=2)); json.dump(out,open('/mnt/data/xau_one_shot_work/rank6_validation.json','w'),indent=2)
