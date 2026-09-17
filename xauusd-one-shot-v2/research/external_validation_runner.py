"""Frozen external validator for ONE SHOT V2.

Purpose:
- Download untouched XAUUSD M1 BID and ASK with dukascopy-go (optional).
- Build M5 bars from true BID/ASK.
- Run the frozen V2 entry + BE at +1.5R / TP5 using TRUE side-aware execution.
- Use true calendar 48-hour timeout; no parameter search is performed here.

Install/download example:
  pip install dukascopy-go pandas numpy
  python external_validation_runner.py --download --from-date 2018-01-01 --to-date 2024-01-01

The script intentionally does not optimize parameters. Treat the selected external period as a one-shot holdout.
"""
from __future__ import annotations
import argparse, json, math, subprocess
from pathlib import Path
import numpy as np
import pandas as pd


def run_download(out: Path, start: str, end: str):
    out.mkdir(parents=True, exist_ok=True)
    commands = [
        ["dukascopy-go","download","--symbol","xauusd","--timeframe","m1","--side","bid","--from",start,"--to",end,"--output",str(out/"xauusd_bid_m1.csv.gz"),"--parallelism","8"],
        ["dukascopy-go","download","--symbol","xauusd","--timeframe","m1","--side","ask","--from",start,"--to",end,"--output",str(out/"xauusd_ask_m1.csv.gz"),"--parallelism","8"],
    ]
    for cmd in commands:
        print("RUN:"," ".join(cmd)); subprocess.run(cmd,check=True)


def load_side(path: Path) -> pd.DataFrame:
    x=pd.read_csv(path)
    low={c.lower():c for c in x.columns}
    tc=next((low[k] for k in ("timestamp","time","datetime","date") if k in low),None)
    if tc is None: raise ValueError(f"No timestamp column in {path}: {list(x.columns)}")
    s=x[tc]
    if np.issubdtype(s.dtype,np.number):
        med=float(pd.to_numeric(s,errors="coerce").dropna().median())
        unit="ms" if med>1e11 else "s"
        idx=pd.to_datetime(s,unit=unit,utc=True)
    else: idx=pd.to_datetime(s,utc=True)
    cols={k:low[k] for k in ("open","high","low","close")}
    y=x[[cols[k] for k in ("open","high","low","close")]].copy();y.columns=["open","high","low","close"];y.index=idx
    return y.sort_index().dropna()


def m5(side: pd.DataFrame) -> pd.DataFrame:
    return side.resample("5min",label="left",closed="left").agg(open=("open","first"),high=("high","max"),low=("low","min"),close=("close","last")).dropna()


def stats(r):
    r=np.asarray(r,float)
    if len(r)==0:return {"n":0,"meanR":None,"pf":None,"win":None,"sumR":0.0}
    neg=-r[r<0].sum()
    return {"n":int(len(r)),"meanR":float(r.mean()),"pf":float(r[r>0].sum()/neg) if neg>0 else 99.0,"win":float((r>0).mean()),"sumR":float(r.sum())}


def validate(bid_m1: pd.DataFrame,ask_m1: pd.DataFrame,start: str,end: str,cost_mult=1.0):
    b=m5(bid_m1);a=m5(ask_m1)
    common=b.index.intersection(a.index);b=b.loc[common];a=a.loc[common]
    # Signals remain BID-derived, matching frozen research convention.
    q=b.resample("15min",label="left",closed="left").agg(open=("open","first"),high=("high","max"),low=("low","min"),close=("close","last")).dropna()
    prev=q.close.shift();tr=pd.concat([q.high-q.low,(q.high-prev).abs(),(q.low-prev).abs()],axis=1).max(axis=1)
    q["atr"]=tr.ewm(alpha=1/14,adjust=False,min_periods=14).mean()
    lo32=q.low.shift(1).rolling(32).min();hi32=q.high.shift(1).rolling(32).max();q["pos32"]=(q.close-lo32)/(hi32-lo32)
    q["atrrel"]=q.atr/q.atr.shift().rolling(50).mean();q["body"]=(q.close-q.open)/q.atr
    for rule,prefix in [("1h","h1"),("4h","h4")]:
        h=b.resample(rule,label="left",closed="left").agg(open=("open","first"),high=("high","max"),low=("low","min"),close=("close","last")).dropna()
        hp=h.close.shift();ht=pd.concat([h.high-h.low,(h.high-hp).abs(),(h.low-hp).abs()],axis=1).max(axis=1).ewm(alpha=1/14,adjust=False,min_periods=14).mean()
        e20=h.close.ewm(span=20,adjust=False,min_periods=20).mean();e50=h.close.ewm(span=50,adjust=False,min_periods=50).mean();e200=h.close.ewm(span=200,adjust=False,min_periods=200).mean()
        h["trend"]=(e20-e50)/ht;h["macro"]=(e50-e200)/ht;h.index=h.index+pd.Timedelta(rule);dec=q.index+pd.Timedelta(minutes=15)
        for c in ("trend","macro"):q[f"{prefix}_{c}"]=h[c].reindex(dec,method="ffill").to_numpy()
    q["hour"]=(q.index+pd.Timedelta(minutes=15)).hour
    L=(q.h4_macro>1.0)&(q.h1_trend>0.25)&(q.pos32>0.70)&(q.body>0.30)&q.atrrel.between(0.8,1.8)&q.hour.between(12,21)
    S=(q.h4_macro<-1.0)&(q.h1_trend<-0.25)&(q.pos32<0.30)&(q.body<-0.30)&q.atrrel.between(0.8,1.8)&q.hour.between(12,21)
    sig=np.where(L,1,np.where(S,-1,0))
    decision=q.index+pd.Timedelta(minutes=15);pos=b.index.get_indexer(decision)
    start=pd.Timestamp(start,tz="UTC");end=pd.Timestamp(end,tz="UTC")
    slip=.05*cost_mult;fee=.07*cost_mult;carry=.30*cost_mult;last_exit=-1;rs=[];rows=[]
    for z in np.flatnonzero(sig):
        i=int(pos[z]);side=int(sig[z])
        if i<0 or i<=last_exit or b.index[i]<start or b.index[i]>=end or not np.isfinite(q.atr.iloc[z]):continue
        dist=2.0*float(q.atr.iloc[z]);
        if dist<=0:continue
        entry=(float(a.open.iloc[i])+slip) if side==1 else (float(b.open.iloc[i])-slip)
        stop=entry-side*dist;tp=entry+side*5.0*dist;pending=None;peak=0.0;deadline=b.index[i]+pd.Timedelta(hours=48);fill=None;j=i;reason="TIME"
        for j in range(i,len(b)):
            if b.index[j]>=end:j=max(i,j-1);break
            if pending is not None:
                stop=max(stop,pending) if side==1 else min(stop,pending);pending=None
            if j>i and b.index[j]>=deadline:
                fill=(float(b.open.iloc[j])-slip) if side==1 else (float(a.open.iloc[j])+slip);reason="TIME";break
            if side==1:
                oo,hh,ll=float(b.open.iloc[j]),float(b.high.iloc[j]),float(b.low.iloc[j])
                if oo<=stop:fill=oo-slip;reason="SL";break
                if oo>=tp:fill=tp;reason="TP";break
                if ll<=stop:fill=stop-slip;reason="SL";break
                if hh>=tp:fill=tp;reason="TP";break
                mark=float(b.close.iloc[j])
            else:
                oo,hh,ll=float(a.open.iloc[j]),float(a.high.iloc[j]),float(a.low.iloc[j])
                if oo>=stop:fill=oo+slip;reason="SL";break
                if oo<=tp:fill=tp;reason="TP";break
                if hh>=stop:fill=stop+slip;reason="SL";break
                if ll<=tp:fill=tp;reason="TP";break
                mark=float(a.close.iloc[j])
            peak=max(peak,side*(mark-entry)/dist)
            if peak>=1.5: pending=entry
        if fill is None:
            fill=(float(b.close.iloc[j])-slip) if side==1 else (float(a.close.iloc[j])+slip)
        days=max(0,(b.index[j].normalize()-b.index[i].normalize()).days)
        r=(side*(fill-entry)-fee-carry*days)/dist
        rs.append(r);rows.append({"entry":str(b.index[i]),"exit":str(b.index[j]),"side":side,"net_r":r,"reason":reason,"stop_dist":dist});last_exit=j
    return stats(rs),pd.DataFrame(rows)


def main():
    ap=argparse.ArgumentParser();ap.add_argument("--data-dir",default="external_bidask");ap.add_argument("--from-date",default="2018-01-01");ap.add_argument("--to-date",default="2024-01-01");ap.add_argument("--download",action="store_true");args=ap.parse_args()
    root=Path(args.data_dir)
    if args.download:run_download(root,args.from_date,args.to_date)
    bid=load_side(root/"xauusd_bid_m1.csv.gz");ask=load_side(root/"xauusd_ask_m1.csv.gz")
    result,trades=validate(bid,ask,args.from_date,args.to_date,1.0);result2,_=validate(bid,ask,args.from_date,args.to_date,2.0)
    out={"period":[args.from_date,args.to_date],"normal_cost":result,"double_cost":result2,"frozen_rules":True}
    print(json.dumps(out,indent=2));(root/"external_validation.json").write_text(json.dumps(out,indent=2));trades.to_csv(root/"external_trades.csv",index=False)

if __name__=="__main__":main()
