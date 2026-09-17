import pandas as pd, numpy as np, json, warnings
from numba import njit
warnings.filterwarnings('ignore')
P='/mnt/data/xau_one_shot_work/data/XAUUSD_M5.csv.gz'
d=pd.read_csv(P); d['time']=pd.to_datetime(d.time,utc=True); d=d.set_index('time').sort_index()
q=d.resample('15min',label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last'),spread=('spread','median')).dropna()
prev=q.close.shift(); tr=pd.concat([q.high-q.low,(q.high-prev).abs(),(q.low-prev).abs()],axis=1).max(axis=1); q['atr']=tr.ewm(alpha=1/14,adjust=False,min_periods=14).mean()
for n in [20,50,200]: q[f'ema{n}']=q.close.ewm(span=n,adjust=False,min_periods=n).mean()
q['rsi']=100-100/(1+q.close.diff().clip(lower=0).ewm(alpha=1/14,adjust=False).mean()/(-q.close.diff().clip(upper=0)).ewm(alpha=1/14,adjust=False).mean())
for n in [4,8,16,32]: q[f'ret{n}']=(q.close-q.close.shift(n))/q.atr
for n in [16,32,64]:
    lo=q.low.shift(1).rolling(n).min(); hi=q.high.shift(1).rolling(n).max(); q[f'pos{n}']=(q.close-lo)/(hi-lo); q[f'brhi{n}']=(q.close-hi)/q.atr; q[f'brlo{n}']=(q.close-lo)/q.atr
q['atrrel']=q.atr/q.atr.shift().rolling(50).mean(); q['body']=(q.close-q.open)/q.atr; q['ema20_50']=(q.ema20-q.ema50)/q.atr; q['ema50_200']=(q.ema50-q.ema200)/q.atr
# HTF completed trend
for rule,prefix in [('1h','h1'),('4h','h4')]:
 h=d.resample(rule,label='left',closed='left').agg(open=('open','first'),high=('high','max'),low=('low','min'),close=('close','last')).dropna(); hp=h.close.shift(); ht=pd.concat([h.high-h.low,(h.high-hp).abs(),(h.low-hp).abs()],axis=1).max(axis=1).ewm(alpha=1/14,adjust=False,min_periods=14).mean(); e20=h.close.ewm(span=20,adjust=False,min_periods=20).mean(); e50=h.close.ewm(span=50,adjust=False,min_periods=50).mean(); e200=h.close.ewm(span=200,adjust=False,min_periods=200).mean(); h['trend']=(e20-e50)/ht; h['macro']=(e50-e200)/ht; h['mom']=(h.close-h.close.shift(4))/ht; h.index=h.index+pd.Timedelta(rule); dec=q.index+pd.Timedelta(minutes=15)
 for c in ['trend','macro','mom']: q[f'{prefix}_{c}']=h[c].reindex(dec,method='ffill').to_numpy()
q['hour']=(q.index+pd.Timedelta(minutes=15)).hour
# raw m5 arrays
dec=q.index+pd.Timedelta(minutes=15); pos=d.index.get_indexer(dec).astype(np.int64); o=d.open.to_numpy(float); hi=d.high.to_numpy(float); lo=d.low.to_numpy(float); cl=d.close.to_numpy(float); sp=d.spread.to_numpy(float)
@njit(cache=True)
def outs(pos,atr,o,hi,lo,cl,sp,side,stopk,rr,maxbars=288):
 n=len(pos); out=np.empty(n); out[:]=np.nan; slip=.05; fee=.07
 for z in range(n):
  i=pos[z]
  if i<0 or i>=len(o) or not np.isfinite(atr[z]): continue
  en=(o[i]+(sp[i] if side==1 else 0))+side*slip; dist=stopk*atr[z]
  if not np.isfinite(dist) or dist<=0: continue
  st=en-side*dist; tp=en+side*rr*dist; ex=np.nan; end=min(len(o),i+maxbars); j=i
  for j in range(i,end):
   oo=o[j]+(sp[j] if side==-1 else 0); hh=hi[j]+(sp[j] if side==-1 else 0); ll=lo[j]+(sp[j] if side==-1 else 0)
   if side==1:
    if oo<=st: ex=oo-slip; break
    if oo>=tp: ex=tp; break
    if ll<=st: ex=st-slip; break
    if hh>=tp: ex=tp; break
   else:
    if oo>=st: ex=oo+slip; break
    if oo<=tp: ex=tp; break
    if hh>=st: ex=st+slip; break
    if ll<=tp: ex=tp; break
  if not np.isfinite(ex):
   j=end-1; ex=(cl[j]+(sp[j] if side==-1 else 0))-side*slip
  out[z]=(side*(ex-en)-fee)/dist
 return out

def stat(r):
 r=np.asarray(r); r=r[np.isfinite(r)]; neg=-r[r<0].sum(); return dict(n=len(r),meanR=float(r.mean()) if len(r) else -99,pf=float(r[r>0].sum()/neg) if neg>0 else 99,win=float((r>0).mean()) if len(r) else 0,sumR=float(r.sum()))
year=q.index.year.to_numpy(); dt=q.index
rules=[]
# family generators. direction-symmetric by construction, except session filters.
for stopk in [1.0,1.5,2.0]:
 yL=outs(pos,q.atr.to_numpy(float),o,hi,lo,cl,sp,1,stopk,3.0); yS=outs(pos,q.atr.to_numpy(float),o,hi,lo,cl,sp,-1,stopk,3.0)
 for ht in [0,0.25,0.5,1.0]:
  for hp in [0,0.25,0.5]:
   for poscut in [0.7,0.8,0.9,1.0]:
    for body in [0,0.15,0.3]:
     # trend continuation / breakout
     L=(q.h4_macro>ht)&(q.h1_trend>hp)&(q.pos32>poscut)&(q.body>body)&(q.atrrel.between(.8,1.8))
     S=(q.h4_macro<-ht)&(q.h1_trend<-hp)&(q.pos32<(1-poscut))&(q.body<-body)&(q.atrrel.between(.8,1.8))
     rules.append((stopk,'trend',ht,hp,poscut,body,L.to_numpy(),S.to_numpy(),yL,yS))
 for ht in [0,0.25,0.5]:
  for rsi in [25,30,35,40]:
   for body in [0,0.1,0.2]:
    # trend pullback reversal: macro trend, local oversold/overbought + reversal candle
    L=(q.h4_macro>ht)&(q.h1_macro>0)&(q.rsi<rsi)&(q.body>body)&(q.ret8<0)&(q.pos32<.45)
    S=(q.h4_macro<-ht)&(q.h1_macro<0)&(q.rsi>(100-rsi))&(q.body<-body)&(q.ret8>0)&(q.pos32>.55)
    rules.append((stopk,'pullback',ht,rsi,0,body,L.to_numpy(),S.to_numpy(),yL,yS))
 for macro in [0.25,0.5,1.0]:
  for rsi in [20,25,30,35]:
   for body in [0,0.1,0.2]:
    # mean reversion only when macro trend weak
    L=(q.h4_macro.abs()<macro)&(q.rsi<rsi)&(q.pos32<.15)&(q.body>body)
    S=(q.h4_macro.abs()<macro)&(q.rsi>(100-rsi))&(q.pos32>.85)&(q.body<-body)
    rules.append((stopk,'meanrev',macro,rsi,0,body,L.to_numpy(),S.to_numpy(),yL,yS))
 # direct donchian breakout
 for n in [16,32,64]:
  for br in [0,0.1,0.2,0.4]:
   for trend in [0,0.25,0.5]:
    L=(q[f'brhi{n}']>br)&(q.h1_trend>trend)&(q.h4_macro>0)&(q.body>0)
    S=(q[f'brlo{n}']<-br)&(q.h1_trend<-trend)&(q.h4_macro<0)&(q.body<0)
    rules.append((stopk,'donchian',n,br,trend,0,L.to_numpy(),S.to_numpy(),yL,yS))

# Evaluate 2024 and 2025 only; allow max one direction per bar (rules mutually symmetric mostly)
cands=[]
for z,r in enumerate(rules):
 stopk,fam,a,b,c,e,L,S,yL,yS=r
 for sessname,sess in [('all',np.ones(len(q),bool)),('london_ny',((q.hour>=7)&(q.hour<=20)).to_numpy()),('ny',((q.hour>=12)&(q.hour<=21)).to_numpy())]:
  rr_all=np.concatenate([yL[L&sess],yS[S&sess]])
  yy_all=np.concatenate([year[L&sess],year[S&sess]])
  s24=stat(rr_all[yy_all==2024]); s25=stat(rr_all[yy_all==2025])
  if s24['n']>=40 and s25['n']>=40:
   worst=min(s24['meanR'],s25['meanR']); score=worst-0.0004*(s24['n']+s25['n'])**0.5 # tiny complexity/volume penalty
   cands.append((score,min(s24['pf'],s25['pf']),z,sessname,s24,s25))
cands.sort(key=lambda x:(x[0],x[1]),reverse=True)
# reveal 2026 only now
out=[]
for rank,cand in enumerate(cands[:30]):
 score,pfw,z,sessname,s24,s25=cand; stopk,fam,a,b,c,e,L,S,yL,yS=rules[z]; sess=np.ones(len(q),bool) if sessname=='all' else (((q.hour>=7)&(q.hour<=20)).to_numpy() if sessname=='london_ny' else ((q.hour>=12)&(q.hour<=21)).to_numpy())
 rr_all=np.concatenate([yL[L&sess],yS[S&sess]]); tt=np.concatenate([dt.to_numpy()[L&sess],dt.to_numpy()[S&sess]]); tt=pd.to_datetime(tt,utc=True)
 rec={'rank':rank+1,'family':fam,'stopATR':stopk,'params':[float(a),float(b),float(c),float(e)],'session':sessname,'2024':s24,'2025':s25}
 for name,x,y in [('2026_H1','2026-01-01','2026-06-19'),('FINAL90','2026-06-19','2026-09-17'),('2026_ALL','2026-01-01','2026-09-17')]: rec[name]=stat(rr_all[(tt>=pd.Timestamp(x,tz='UTC'))&(tt<pd.Timestamp(y,tz='UTC'))])
 out.append(rec)
print(json.dumps(out[:15],indent=2))
json.dump(out,open('/mnt/data/xau_one_shot_work/rule_scan_results.json','w'),indent=2)
