/**
 * 看盤教室的教練劇本（跟 SMC 道場 dojo/ 看盤教室同一套規則）。純函式，Candle 格式 {t,o,h,l,c}。
 * 給 Worker 的 Discord「教練提醒」和 scripts/research/coach-study.mjs 回測共用。
 */
export function atrOf(C){var n=C.length,a=new Array(n),s=0;for(var i=0;i<n;i++){var tr=i?Math.max(C[i].h-C[i].l,Math.abs(C[i].h-C[i-1].c),Math.abs(C[i].l-C[i-1].c)):C[i].h-C[i].l;a[i]=i<14?(s+=tr)/(i+1):(a[i-1]*13+tr)/14}return a}

/* pivots + break-of-structure events for one swing size */
export function structure(C,L,atr){
  var n=C.length,piv=[],ev=[],trend=0,tr8=new Int8Array(n),lastH=null,lastL=null,pH=null,pL=null,eq=[],j,u;
  for(j=0;j<n;j++){
    var q=j-L;
    if(q>=L){var isH=true,isL=true;
      for(var m=1;m<=L;m++){if(!(C[q].h>C[q-m].h&&C[q].h>=C[q+m].h))isH=false;if(!(C[q].l<C[q-m].l&&C[q].l<=C[q+m].l))isL=false}
      if(isH){var ph={i:q,p:C[q].h,k:j,hi:1,lab:pH?(C[q].h>pH.p?'HH':'LH'):''};piv.push(ph);
        if(pH&&!pH.used&&Math.abs(ph.p-pH.p)<.18*atr[j])eq.push({hi:1,i:pH.i,p:Math.max(ph.p,pH.p),k:j,sw:null});pH=ph;lastH=ph}
      if(isL){var pl={i:q,p:C[q].l,k:j,hi:0,lab:pL?(C[q].l<pL.p?'LL':'HL'):''};piv.push(pl);
        if(pL&&!pL.used&&Math.abs(pl.p-pL.p)<.18*atr[j])eq.push({hi:0,i:pL.i,p:Math.min(pl.p,pL.p),k:j,sw:null});pL=pl;lastL=pl}}
    var c=C[j];
    if(lastH&&!lastH.used&&c.c>lastH.p){lastH.used=1;ev.push({t:trend<0?'CHoCH':'BOS',dir:1,from:lastH.i,i:j,k:j,p:lastH.p,prev:trend});trend=1}
    if(lastL&&!lastL.used&&c.c<lastL.p){lastL.used=1;ev.push({t:trend>0?'CHoCH':'BOS',dir:-1,from:lastL.i,i:j,k:j,p:lastL.p,prev:trend});trend=-1}
    tr8[j]=trend}
  eq.forEach(function(e){for(var j=e.k+1;j<n;j++)if(e.hi?C[j].h>e.p:C[j].l<e.p){e.sw=j;break}});
  piv.forEach(function(p){for(var j=p.k;j<n;j++)if(p.hi?C[j].h>p.p:C[j].l<p.p){p.sw=j;break}});
  return {piv:piv,ev:ev,trend:tr8,eq:eq}}

/* grade each CHoCH: sweep / displacement / FVG / decisive close, protected extreme, and what happened next */
function gradeChoch(C,S,atr,horizon){
  var n=C.length;horizon=horizon||60;
  S.ev.forEach(function(e,idx){
    if(e.t!=='CHoCH')return;var d=e.dir,i=e.i,a=atr[i],u;
    /* protected extreme = origin of the move that broke structure */
    var pe=e.from;for(u=e.from;u<=i;u++)if(d>0?C[u].l<C[pe].l:C[u].h>C[pe].h)pe=u;
    e.pi=pe;e.pp=d>0?C[pe].l:C[pe].h;
    /* sweep: the origin took out an earlier swing on that side (and that swing had not been taken before) */
    var sw=null;S.piv.forEach(function(p){if(p.hi===(d>0?0:1)&&p.k<=pe&&pe-p.i<=80&&p.i<pe&&(d>0?C[pe].l<p.p:C[pe].h>p.p)&&(p.sw==null||p.sw>=pe-1))sw=p});
    e.fSweep=!!sw;e.swp=sw?sw.p:null;e.swi=sw?sw.i:null;
    /* displacement: a big-bodied candle in the breaking leg */
    var big=0;for(u=pe+1;u<=i;u++){var b=d*(C[u].c-C[u].o);if(b>=1.1*atr[u]){big=1;break}}e.fDisp=!!big;
    /* imbalance left behind in the breaking leg */
    var fv=0;for(u=Math.max(pe+2,2);u<=Math.min(n-1,i+1);u++){if(d>0?C[u].l>C[u-2].h:C[u].h<C[u-2].l){fv=1;e.fvI=u-1;e.fvP=d>0?[C[u-2].h,C[u].l]:[C[u].h,C[u-2].l];break}}e.fFvg=!!fv;
    /* decisive close beyond the level, not a marginal poke */
    e.fClose=d*(C[i].c-e.p)>=.25*a;
    e.score=(e.fSweep?1:0)+(e.fDisp?1:0)+(e.fFvg?1:0)+(e.fClose?1:0);
    /* outcome: BOS in the new direction (confirmed) vs close through the protected extreme (failed) */
    e.res=0;e.rk=null;
    for(u=i+1;u<Math.min(n,i+horizon);u++){
      if(d>0?C[u].c<e.pp:C[u].c>e.pp){e.res=-1;e.rk=u;break}
      var nx=null;for(var q2=idx+1;q2<S.ev.length;q2++){var e2=S.ev[q2];if(e2.i>u)break;if(e2.i===u){nx=e2;break}}
      if(nx&&nx.dir===d&&nx.t==='BOS'){e.res=1;e.rk=u;break}
      if(nx&&nx.dir!==d){e.res=-1;e.rk=u;break}}
  })}

/* one call = everything the replay and the drill need */
export function analyze(C,Le,Li){
  Le=Le||4;Li=Li||2;var atr=atrOf(C),n=C.length,j,u;
  var X=structure(C,Le,atr),I=structure(C,Li,atr);gradeChoch(C,X,atr);
  /* an internal break is "internal" only when it does not also break the external swing on that bar */
  var extAt={};X.ev.forEach(function(e){extAt[e.i+'_'+e.dir]=1});
  I.ev.forEach(function(e){e.ext=!!extAt[e.i+'_'+e.dir];e.xt=X.trend[e.i-1]||0});
  var fv=[],obs=[];
  for(j=2;j<n;j++){
    if(C[j].l>C[j-2].h&&C[j].l-C[j-2].h>.12*atr[j])fv.push({dir:1,i:j-1,p1:C[j-2].h,p2:C[j].l,k:j,fill:null});
    if(C[j].h<C[j-2].l&&C[j-2].l-C[j].h>.12*atr[j])fv.push({dir:-1,i:j-1,p1:C[j].h,p2:C[j-2].l,k:j,fill:null})}
  X.ev.forEach(function(e){var d=e.dir,m=e.from;for(u=e.from;u<=e.i;u++)if(d>0?C[u].l<C[m].l:C[u].h>C[m].h)m=u;
    for(u=m;u>=Math.max(0,m-6);u--)if(d>0?C[u].c<C[u].o:C[u].c>C[u].o){obs.push({dir:d,i:u,p1:C[u].h,p2:C[u].l,k:e.i,inv:null});break}});
  fv.forEach(function(f){for(var j=f.k+1;j<n;j++)if(f.dir>0?C[j].l<=f.p1:C[j].h>=f.p2){f.fill=j;break}});
  obs.forEach(function(o){for(var j=o.k+1;j<n;j++)if(o.dir>0?C[j].c<o.p2:C[j].c>o.p1){o.inv=j;break}});
  return {atr:atr,piv:X.piv,ev:X.ev,trend:X.trend,eq:X.eq,ipiv:I.piv,iev:I.ev,itrend:I.trend,fv:fv,obs:obs}}
export function aggregate(C,upto,g,dt){
  var out=[],cur=null,span=dt*g;
  for(var i=0;i<=upto;i++){var k=C[i],b=Math.floor(k.t/span);
    if(!cur||cur.b!==b){cur={b:b,t:b*span,o:k.o,h:k.h,l:k.l,c:k.c,i0:i};out.push(cur)}
    else{cur.h=Math.max(cur.h,k.h);cur.l=Math.min(cur.l,k.l);cur.c=k.c}}
  return out}

/**
 * 看盤教室的教練劇本（跟 SMC 道場 dojo/ 看盤教室同一套規則），只用到第 n-1 根（已收盤）。
 *   1 掃流動性：最近 45 根內，影線刺破一個還沒被碰過的擺動低（做多）／高（做空），當根或下一根收回
 *   2 結構轉向：掃蕩之後出現同方向的外部 BOS／CHoCH（擺動點左右各 4 根）
 *   3 POI：掃蕩之後留下、還沒被回補的同方向 FVG（沒有就用 OB）
 *   4 回踩：POI 形成後價格回到 POI
 *   5 計畫：進場＝POI 邊緣、停損＝掃出來的極值外 0.15 ATR、目標＝最近還沒被掃的對面擺動點（沒有就用近 80 根區間極值）
 *   背景：大週期方向 bias（另外算）、折價／溢價（近 80 根區間 50%）
 */
export function coachState(W, A, bias) {
  const n = W.length, j = n - 1, px = W[j].c, a = A.atr[j], out = {};
  let rH = -1e18, rL = 1e18;
  for (let i = Math.max(0, n - 80); i < n; i++) { rH = Math.max(rH, W[i].h); rL = Math.min(rL, W[i].l); }
  const eq = (rH + rL) / 2;
  for (const d of [1, -1]) {
    const r = { d, bias: bias === d ? 2 : bias === 0 ? 1 : 0, disc: d > 0 ? px < eq : px > eq, ready: false };
    let sw = null;
    for (const p of A.piv) {
      if (p.hi !== (d > 0 ? 0 : 1) || p.k > j) continue;
      for (let u = Math.max(p.k, n - 45); u <= j; u++) {
        if (u <= p.i) continue;
        if (!(d > 0 ? W[u].l < p.p : W[u].h > p.p)) continue;
        let prev = false;
        for (let q = p.i + 1; q < u; q++) if (d > 0 ? W[q].l < p.p : W[q].h > p.p) { prev = true; break; }
        if (prev) break;
        const back = d > 0 ? (W[u].c > p.p || (u < j && W[u + 1].c > p.p)) : (W[u].c < p.p || (u < j && W[u + 1].c < p.p));
        if (back && (!sw || u > sw.u)) sw = { u, p: p.p, x: d > 0 ? W[u].l : W[u].h };
        break;
      }
    }
    if (sw) {
      let ext = sw.x;
      for (let u = sw.u; u <= j; u++) ext = d > 0 ? Math.min(ext, W[u].l) : Math.max(ext, W[u].h);
      for (let u = sw.u + 1; u <= j; u++) if (d > 0 ? W[u].c < sw.x : W[u].c > sw.x) { sw.dead = u; break; }
      sw.ext = ext;
    }
    const okSw = sw && !sw.dead;
    r.sweep = okSw ? sw : null;
    let ev = null;
    if (okSw) for (const e of A.ev) if (e.dir === d && e.i > sw.u && e.i <= j) { ev = e; break; }
    let poi = null;
    if (okSw && ev) {
      for (const f of A.fv) if (f.dir === d && f.i >= sw.u - 1 && f.k <= j && (f.fill == null || f.fill > j)) { poi = { kind: 'FVG', top: Math.max(f.p1, f.p2), bot: Math.min(f.p1, f.p2), i: f.i, k: f.k }; break; }
      if (!poi) for (const o of A.obs) if (o.dir === d && o.i >= sw.u - 2 && o.k <= j && (o.inv == null || o.inv > j)) { poi = { kind: 'OB', top: o.p1, bot: o.p2, i: o.i, k: o.k }; break; }
    }
    let rt = null;
    if (poi) for (let u = poi.k + 1; u <= j; u++) if (d > 0 ? W[u].l <= poi.top : W[u].h >= poi.bot) { rt = u; break; }
    r.ev = ev ? { p: ev.p, t: ev.t, i: ev.i } : null;
    r.poi = poi;
    r.rt = rt;
    r.stage = !okSw ? 0 : !ev ? 1 : !poi ? 2 : rt == null ? 3 : 4;
    if (poi && rt != null) {
      const en = d > 0 ? poi.top : poi.bot, sl = sw.ext - d * 0.15 * a;
      let tp = null;
      for (const p of A.piv) if (p.hi === (d > 0 ? 1 : 0) && p.k <= j && (p.sw == null || p.sw > j) && (d > 0 ? p.p > en + 0.5 * a : p.p < en - 0.5 * a)) tp = tp == null ? p.p : (d > 0 ? Math.min(tp, p.p) : Math.max(tp, p.p));
      if (tp == null) tp = d > 0 ? rH : rL;
      const rr = d * (tp - en) / (d * (en - sl));
      if (d * (en - sl) > 0 && rr > 0) { r.ready = true; r.plan = { en, sl, tp, rr, kind: poi.kind, swU: sw.u, rt }; }
    }
    out[d > 0 ? 'L' : 'S'] = r;
  }
  return out;
}
