/** 迷你 DOM 工具 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function setHTML(target, html) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = html;
  return node;
}

export function toast(message, kind = 'info', ms = 3200) {
  let host = $('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast toast--${kind}`, text: message });
  host.append(node);
  setTimeout(() => {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 300);
  }, ms);
}
