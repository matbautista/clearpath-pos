const api = (() => {
  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body || {}),
    del: (url) => request('DELETE', url),
  };
})();

// What a role can do on an order-taking screen (Register/Tables):
// 'full' — cashier: build the order AND charge it.
// 'order' — waiter: build the order (add items, send to kitchen), but never
//   charge — only a cashier's own open shift can take payment.
// 'view' — admin/manager: read-only, per their "not able to transact" access.
function orderCapability(role) {
  if (role === 'cashier') return 'full';
  if (role === 'waiter') return 'order';
  return 'view';
}

function ensureGlobalEmbers() {
  if (document.getElementById('global-embers')) return;
  const embersEl = document.createElement('div');
  embersEl.id = 'global-embers';
  embersEl.className = 'embers';
  const emberCount = window.innerWidth < 640 ? 14 : 26;
  for (let i = 0; i < emberCount; i++) {
    const size = 2 + Math.random() * 4;
    const ember = document.createElement('div');
    ember.className = 'ember';
    ember.style.width = `${size}px`;
    ember.style.height = `${size}px`;
    ember.style.left = `${Math.random() * 100}%`;
    ember.style.setProperty('--drift', `${Math.random() * 60 - 30}px`);
    ember.style.animationDuration = `${6 + Math.random() * 8}s`;
    ember.style.animationDelay = `${Math.random() * 10}s`;
    embersEl.appendChild(ember);
  }
  document.body.appendChild(embersEl);
}

function toast(message, type = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function money(n, symbol) {
  const sym = symbol ?? (window.APP_STATE && window.APP_STATE.settings ? window.APP_STATE.settings.currency_symbol : '₱');
  return `${sym}${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function productTileStyle(p) {
  if (p.image_url) {
    return `background-image:linear-gradient(180deg, rgba(14,10,8,.1) 0%, rgba(14,10,8,.88) 100%), url('${p.image_url}'); background-size:cover; background-position:center;`;
  }
  return `background:${p.color || 'var(--primary)'};`;
}

// Prompts for an admin PIN to approve a restricted action (e.g. editing an
// order already sent to the kitchen). Resolves to the entered PIN string, or
// null if the prompt was cancelled. The PIN itself is verified server-side.
function promptAdminPin(message) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const pinInput = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'Admin PIN' });
    const errorEl = el('div', { class: 'login-error' }, '');
    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      document.body.removeChild(backdrop);
      resolve(value);
    }
    const submit = () => {
      if (!pinInput.value.trim()) { errorEl.textContent = 'Enter an admin PIN'; return; }
      close(pinInput.value.trim());
    };
    pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const modal = el('div', { class: 'modal', style: 'width:340px;' }, [
      el('h3', {}, 'Admin Approval Required'),
      el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:-6px;' },
        message || 'This action needs an admin to approve it.'),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [pinInput]),
      errorEl,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: submit }, 'Approve'),
      ]),
    ]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    pinInput.focus();
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
