import importlib.util,contextlib,io,numpy as np,json
spec=importlib.util.spec_from_file_location('ev','/mnt/data/XAUUSD_ONE_SHOT_V2_VALIDATED/exit_variants.py'); ev=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(ev)
r=np.asarray(ev.run('2024-01-01','2026-09-17','BE15_TP5'),float)
N=len(r); rng=np.random.default_rng(260917); block=8

def sim_path(rs, base=.06, start=60., floor0=20., safety=1.15):
    e=start;peak=e;dd=0.;floor=floor0;hit=False
    milestones=((100,60),(300,150),(1000,500),(3000,1500),(10000,5000))
    for x in rs:
        for m,fl in milestones:
            if e>=m and floor<fl: floor=fl
        if e>=10000: hit=True
        budget=max(0.,e-floor)
        if budget<=1e-12: break
        dollar=min(base*e,budget/safety); f=dollar/e
        e*=max(0.,1+f*x); peak=max(peak,e); dd=max(dd,(peak-e)/peak if peak else 1.)
    if e>=10000: hit=True
    return e,dd,hit

def bootstrap(n=N):
    out=[]
    while len(out)<n:
        s=int(rng.integers(0,max(1,N-block+1)))
        out.extend(r[s:s+block])
    return np.array(out[:n])
res={}
for base in [.04,.05,.06,.07]:
    finals=[];dds=[];hits=0
    for _ in range(10000):
        e,dd,h=sim_path(bootstrap(),base)
        finals.append(e);dds.append(dd);hits+=h
    a=np.array(finals);b=np.array(dds)
    res[str(base)]={'hit10000':hits/10000,'final_p5':float(np.quantile(a,.05)),'final_median':float(np.median(a)),'final_p95':float(np.quantile(a,.95)),'dd_median':float(np.median(b)),'dd_p95':float(np.quantile(b,.95))}
print(json.dumps({'trades':N,'block':block,'results':res},indent=2))
json.dump({'trades':N,'block':block,'results':res},open('/mnt/data/XAUUSD_ONE_SHOT_V2_VALIDATED/ratchet_mc_results.json','w'),indent=2)
