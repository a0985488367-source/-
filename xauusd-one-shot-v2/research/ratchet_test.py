import importlib.util,contextlib,io,json,numpy as np
spec=importlib.util.spec_from_file_location('ev','/mnt/data/XAUUSD_ONE_SHOT_V2_VALIDATED/exit_variants.py'); ev=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(ev)
periods={'2024':('2024-01-01','2025-01-01'),'2025':('2025-01-01','2026-01-01'),'2026H1':('2026-01-01','2026-06-19'),'FINAL90':('2026-06-19','2026-09-17')}
R={k:ev.run(a,b,'BE15_TP5') for k,(a,b) in periods.items()}

def ratchet(rs, base=.07, start=60., floor0=20., safety=1.15):
 e=start; peak=e; dd=0.; floor=floor0; hits=[]
 milestones=[(100,60),(300,150),(1000,500),(3000,1500),(10000,5000)]
 for idx,x in enumerate(rs):
  for m,fl in milestones:
   if e>=m and floor<fl:
    floor=fl; hits.append((idx,m,e))
  budget=max(0,e-floor)
  if budget<=0: break
  # dollar 1R risk no more than base equity and no more than cushion/safety
  dollar=min(base*e,budget/safety)
  f=dollar/e
  e*=max(0,1+f*x)
  peak=max(peak,e); dd=max(dd,(peak-e)/peak)
 return {'final':e,'dd':dd,'floor':floor,'hits':hits}

out={}
for b in [.05,.07,.08,.09,.10,.12,.15]:
 out[str(b)]={k:ratchet(v,b) for k,v in R.items()}
print(json.dumps(out,indent=2))
json.dump(out,open('/mnt/data/XAUUSD_ONE_SHOT_V2_VALIDATED/ratchet_results.json','w'),indent=2)
