/** 極簡事件匯流排（發佈／訂閱） */
export function createBus() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    off(evt, fn) { map.get(evt)?.delete(fn); },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(`[bus:${evt}]`, e); }
      });
      map.get('*')?.forEach((fn) => fn({ evt, payload }));
    },
  };
}
export const bus = createBus();
