import numpy as np, pandas as pd, json, itertools, importlib.util, contextlib, io
spec=importlib.util.spec_from_file_location('ev','./exit_variants.py')
ev=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(ev)
run=ev.run
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
R={k:run(a,b,'BE15_TP5') for k,(a,b) in periods.items()}

def apply(rs, tiers, start=60.0):
    e=start; peak=e; dd=0.0; hits={100:False,300:False,1000:False,10000:False}
    for x in rs:
        risk=tiers[-1][1]
        for upper,r in tiers:
            if e<upper: risk=r; break
        e*=max(0.0,1.0+risk*x)
        peak=max(peak,e); dd=max(dd,(peak-e)/peak if peak else 1)
        for h in hits: hits[h] |= e>=h
    return {'final':float(e),'dd':float(dd),**{f'hit{h}':bool(v) for h,v in hits.items()}}

threshold_sets=[(100,300,1000),(120,400,1500),(150,500,2000)]
r1s=[.05,.06,.07,.08,.09,.10]
r2s=[.04,.05,.06,.07]
r3s=[.03,.04,.05]
r4s=[.02,.03,.04]
rows=[]
for th in threshold_sets:
  for r1,r2,r3,r4 in itertools.product(r1s,r2s,r3s,r4s):
    if not (r1>=r2>=r3>=r4): continue
    tiers=[(th[0],r1),(th[1],r2),(th[2],r3),(float('inf'),r4)]
    a=apply(R['2024'],tiers); b=apply(R['2025'],tiers)
    if a['final']>60 and b['final']>60 and max(a['dd'],b['dd'])<=.65:
        score=min(a['final'],b['final'])
        rows.append((score,th,(r1,r2,r3,r4),a,b))
rows.sort(reverse=True,key=lambda x:x[0])
print('candidates',len(rows))
for row in rows[:10]: print(row[:3],row[3],row[4])
if not rows: raise SystemExit('no candidate')
_,th,risks,dev24,dev25=rows[0]
tiers=[(th[0],risks[0]),(th[1],risks[1]),(th[2],risks[2]),(float('inf'),risks[3])]
out={'thresholds':th,'risks':risks,'2024':dev24,'2025':dev25,'2026H1':apply(R['2026H1'],tiers),'FINAL90':apply(R['FINAL90'],tiers)}
out['fixed']={}
for f in [.03,.05,.07,.10]:
    t=[(float('inf'),f)]
    out['fixed'][str(f)]={k:apply(v,t) for k,v in R.items()}
print(json.dumps(out,indent=2,ensure_ascii=False))
json.dump(out,open('./capital_ladder_results.json','w'),indent=2)
