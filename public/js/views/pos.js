let posProducts = [];
let posCategories = [];
let posActiveCategory = null;
let posChannels = [];
let posRefreshGridRef = null;

function productsUrl(state) {
  return `/api/products?active=true${state.channel ? `&channel_id=${state.channel.id}` : ''}`;
}

// Reloads the product list priced for whatever channel is currently
// selected (FoodPanda/GrabFood menu prices are marked up to absorb that
// platform's commission), and re-prices any cart lines already added under
// a different channel so the cart always reflects the active channel's price.
// Also flags cart lines for items that turn out not to be offered on the
// newly selected channel — they stay in the cart (not silently dropped) but
// can't be charged until removed; the server enforces this too.
async function refreshProductsForChannel() {
  const state = window.APP_STATE;
  try {
    posProducts = await api.get(productsUrl(state));
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const blockedNames = [];
  for (const line of state.cart) {
    const p = posProducts.find((pp) => pp.id === line.product_id);
    if (p) {
      line.price = p.price;
      if (p.channel_available === 0) blockedNames.push(p.name);
    }
  }
  if (blockedNames.length) {
    toast(`Not available on ${state.channel ? state.channel.name : 'this channel'}: ${blockedNames.join(', ')} — remove before charging`, 'error');
  }
  if (posRefreshGridRef) posRefreshGridRef();
  refreshCartPanel();
}

async function renderPosView(container) {
  container.innerHTML = '';
  const state = window.APP_STATE;

  try {
    [posProducts, posCategories, state.shift, posChannels] = await Promise.all([
      api.get(productsUrl(state)),
      api.get('/api/categories'),
      api.get('/api/shifts/current'),
      api.get('/api/channels?active=true'),
    ]);
  } catch (e) {
    toast(e.message, 'error');
  }

  // Only admins are exempt from having their own open cash drawer shift.
  if (!state.shift && state.user.role !== 'admin') {
    container.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:center;height:calc(100vh - 40px);' }, [
      el('div', { class: 'card', style: 'max-width:420px;text-align:center;padding:32px;' }, [
        el('div', { style: 'font-size:32px;margin-bottom:8px;' }, '🗄️'),
        el('h2', { style: 'margin:0 0 8px;' }, 'No Shift Open'),
        el('p', { style: 'color:var(--text-muted);font-size:14px;margin-bottom:20px;' },
          'You need to open a cash drawer shift before ringing up any sale — it\'s what end-of-day reconciliation is built on.'),
        el('button', { class: 'btn primary', onclick: () => navigate('shift') }, 'Open Shift'),
      ]),
    ]));
    return;
  }

  const scanInput = el('input', {
    type: 'text',
    placeholder: 'Scan barcode or type SKU, then press Enter…',
    autofocus: 'true',
  });
  scanInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && scanInput.value.trim()) {
      await handleBarcode(scanInput.value.trim());
      scanInput.value = '';
    }
  });

  const categoryTabs = el('div', { class: 'category-tabs' }, [
    el('button', { class: posActiveCategory === null ? 'active' : '', onclick: () => { posActiveCategory = null; refreshGrid(); } }, 'All'),
    ...posCategories.map((c) => el('button', {
      class: posActiveCategory === c.id ? 'active' : '',
      onclick: () => { posActiveCategory = c.id; refreshGrid(); },
    }, c.name)),
  ]);

  const grid = el('div', { class: 'product-grid' });

  function refreshGrid() {
    grid.innerHTML = '';
    const items = posProducts.filter((p) => posActiveCategory === null || p.category_id === posActiveCategory);
    if (items.length === 0) {
      grid.appendChild(el('div', { class: 'empty-state' }, 'No products in this category yet.'));
      return;
    }
    for (const p of items) {
      const outOfStock = p.track_stock && p.stock_qty <= 0;
      const channelBlocked = p.channel_available === 0;
      const disabled = outOfStock || channelBlocked;
      grid.appendChild(el('button', {
        class: `product-tile ${disabled ? 'out' : ''}`,
        style: productTileStyle(p),
        disabled: disabled ? 'true' : null,
        onclick: () => addToCart(p),
      }, [
        el('div', { class: 'name' }, p.name),
        el('div', {}, [
          el('div', { class: 'price' }, money(p.price)),
          el('div', { class: 'stock' }, channelBlocked
            ? `Not on ${state.channel ? state.channel.name : 'channel'}`
            : (p.track_stock ? `${p.stock_qty} in stock` : '')),
        ]),
      ]));
    }
  }
  refreshGrid();
  posRefreshGridRef = refreshGrid;

  const posLeft = el('div', { class: 'pos-left' }, [
    el('div', { class: 'scan-bar' }, [scanInput]),
    categoryTabs,
    grid,
  ].filter(Boolean));

  const cartPanel = renderCartPanel();

  container.appendChild(el('div', { class: 'pos-layout' }, [posLeft, cartPanel]));
  scanInput.focus();
}

async function handleBarcode(code) {
  const local = posProducts.find((p) => p.barcode === code || p.sku === code);
  if (local) { addToCart(local); return; }
  try {
    const p = await api.get(`/api/products/barcode/${encodeURIComponent(code)}`);
    addToCart(p);
  } catch (e) {
    toast(`No product found for "${code}"`, 'error');
  }
}

function addToCart(product) {
  const state = window.APP_STATE;
  if (product.channel_available === 0) {
    toast(`${product.name} is not available on ${state.channel ? state.channel.name : 'this channel'}`, 'error');
    return;
  }
  const existing = state.cart.find((l) => l.product_id === product.id);
  if (existing) {
    if (product.track_stock && existing.qty + 1 > product.stock_qty) {
      toast(`Only ${product.stock_qty} in stock`, 'error');
      return;
    }
    existing.qty += 1;
  } else {
    if (product.track_stock && product.stock_qty <= 0) { toast('Out of stock', 'error'); return; }
    const takeoutActive = state.scPwdDiscount.type !== 'none' && state.scPwdDiscount.isTakeout;
    state.cart.push({
      product_id: product.id, name: product.name, price: product.price,
      tax_rate: product.tax_rate, qty: 1, discount: 0, track_stock: product.track_stock, stock_qty: product.stock_qty,
      // How many units of this line are SC/PWD-eligible (0..qty), not just a
      // yes/no — a line can be partly eligible (e.g. 2 of 3 consumed by the
      // cardholder). undefined means "fully eligible, tracks qty" — the
      // dine-in default, so tapping the same product again to bump qty keeps
      // the whole line eligible without extra bookkeeping here; it only
      // becomes a fixed number once staff explicitly edits the checkbox/qty
      // input. Takeout defaults to a fixed 0 since only a single unit — the
      // priciest item's — should ever qualify when consumption can't be
      // tracked; staff picks which one.
      sc_pwd_eligible_qty: takeoutActive ? 0 : undefined,
    });
  }
  refreshCartPanel();
}

// Mirrors the checkout math in server/routes/sales.js: RA 9994 (Senior
// Citizens) / RA 10754 (PWD) mandate 20% off the VAT-exclusive price, with
// the sale becoming VAT-exempt, for the eligible portion of a line.
function computeSubtotal(price, qty, taxRate, manualDiscount, scPwdEligible) {
  const gross = price * qty - manualDiscount;
  if (scPwdEligible) {
    const vatExclusive = gross / (1 + taxRate);
    const vatExemptAmount = gross - vatExclusive;
    const scPwdDiscount = vatExclusive * 0.2;
    return { taxAmount: 0, vatExemptAmount, discount: manualDiscount + scPwdDiscount, lineTotal: vatExclusive - scPwdDiscount };
  }
  const taxAmount = gross * taxRate;
  return { taxAmount, vatExemptAmount: 0, discount: manualDiscount, lineTotal: gross + taxAmount };
}

// A line can be partially eligible (e.g. 2 of 3 units consumed by the
// cardholder) — split it into an eligible sub-quantity and a regular
// sub-quantity and sum their results. sc_pwd_eligible_qty === 0 or === qty
// collapses back to the old fully-not/fully-eligible behavior.
function computeLine(line) {
  const scPwdActive = window.APP_STATE.scPwdDiscount.type !== 'none';
  // undefined sc_pwd_eligible_qty means "fully eligible, tracks qty" (the
  // dine-in default) — only a concrete number (explicitly set by staff, incl.
  // 0) overrides that, so ?? (not ||) is required here.
  const eligibleQty = scPwdActive ? Math.max(0, Math.min(line.sc_pwd_eligible_qty ?? line.qty, line.qty)) : 0;
  const regularQty = line.qty - eligibleQty;
  // line.discount (manual per-line discount) isn't currently settable from
  // any UI — it's always 0 in practice, so it's applied to the regular
  // portion only rather than splitting it proportionally.
  const elig = computeSubtotal(line.price, eligibleQty, line.tax_rate, 0, true);
  const reg = computeSubtotal(line.price, regularQty, line.tax_rate, line.discount, false);
  return {
    taxAmount: elig.taxAmount + reg.taxAmount,
    vatExemptAmount: elig.vatExemptAmount + reg.vatExemptAmount,
    lineDiscount: elig.discount + reg.discount,
    lineTotal: elig.lineTotal + reg.lineTotal,
  };
}

function cartTotals() {
  const cart = window.APP_STATE.cart;
  let subtotal = 0, discountTotal = 0, taxTotal = 0, vatExemptTotal = 0;
  for (const l of cart) {
    const c = computeLine(l);
    subtotal += l.price * l.qty;
    discountTotal += c.lineDiscount;
    taxTotal += c.taxAmount;
    vatExemptTotal += c.vatExemptAmount;
  }
  const total = subtotal - discountTotal - vatExemptTotal + taxTotal;
  return { subtotal, discountTotal, taxTotal, vatExemptTotal, total };
}

let cartPanelRef = null;

function renderCartPanel() {
  cartPanelRef = el('div', { class: 'pos-right' });
  refreshCartPanel();
  return cartPanelRef;
}

function refreshCartPanel() {
  if (!cartPanelRef) return;
  cartPanelRef.innerHTML = '';
  const state = window.APP_STATE;
  const cart = state.cart;

  const discount = state.scPwdDiscount;
  const discountLabel = discount.type === 'senior' ? 'Senior' : discount.type === 'pwd' ? 'PWD' : null;

  const header = el('div', { class: 'cart-header' }, [
    el('h3', {}, `Cart (${cart.reduce((s, l) => s + l.qty, 0)})`),
    el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;' }, [
      el('button', {
        class: `btn small ${discountLabel ? '' : 'ghost'}`,
        style: discountLabel ? 'background:#1ea672;border-color:#1ea672;color:#fff;' : '',
        onclick: () => openScPwdModal(refreshCartPanel),
      }, discountLabel ? `🎫 ${discountLabel}${discount.isTakeout ? ' 🥡' : ''}` : '🎫 SC/PWD'),
      el('button', { class: 'btn ghost small', onclick: () => { state.customer = null; openCustomerPicker(refreshCartPanel); } }, state.customer ? state.customer.name : '+ Customer'),
      el('button', { class: 'btn ghost small', onclick: () => openChannelPicker(refreshProductsForChannel) }, `🛵 ${state.channel ? state.channel.name : 'Walk-in'}`),
    ]),
  ]);

  const itemsEl = el('div', { class: 'cart-items' });
  if (cart.length === 0) {
    itemsEl.appendChild(el('div', { class: 'cart-empty' }, 'Cart is empty. Tap a product or scan a barcode.'));
  } else {
    cart.forEach((line, idx) => {
      const c = computeLine(line);
      // Any dish, any quantity can carry the discount — checkboxes are
      // independent (not mutually exclusive). A qty-1 line is a plain
      // checkbox; a qty>1 line gets a number input so staff can pick exactly
      // how many units of it qualify (e.g. 2 of 3 consumed by the cardholder).
      const eligibilityToggle = discountLabel
        ? el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);white-space:nowrap;' }, [
            line.qty <= 1
              ? (() => {
                  const cb = el('input', { type: 'checkbox' });
                  cb.checked = (line.sc_pwd_eligible_qty ?? line.qty) >= 1;
                  cb.addEventListener('change', () => { line.sc_pwd_eligible_qty = cb.checked ? 1 : 0; refreshCartPanel(); });
                  return cb;
                })()
              : (() => {
                  const numInput = el('input', { type: 'number', min: '0', max: String(line.qty), step: '1', value: String(line.sc_pwd_eligible_qty ?? line.qty), style: 'width:42px;padding:2px 4px;' });
                  numInput.addEventListener('input', () => {
                    line.sc_pwd_eligible_qty = Math.max(0, Math.min(line.qty, Number(numInput.value) || 0));
                    refreshCartPanel();
                  });
                  return numInput;
                })(),
            line.qty <= 1 ? discountLabel : `/${line.qty} ${discountLabel}`,
          ])
        : null;
      itemsEl.appendChild(el('div', { class: 'cart-item' }, [
        el('div', { class: 'info' }, [
          el('div', { class: 'name' }, line.name),
          el('div', { class: 'price' }, `${money(line.price)} ea`),
        ]),
        eligibilityToggle,
        el('div', { class: 'qty-control' }, [
          el('button', { onclick: () => changeQty(idx, -1) }, '−'),
          el('span', {}, String(line.qty)),
          el('button', { onclick: () => changeQty(idx, 1) }, '+'),
        ]),
        el('div', { class: 'line-total' }, money(c.lineTotal)),
        el('button', { class: 'remove-line', onclick: () => { cart.splice(idx, 1); refreshCartPanel(); } }, '✕'),
      ].filter(Boolean)));
    });
  }

  const totals = cartTotals();
  const totalsEl = el('div', { class: 'cart-totals' }, [
    el('div', { class: 'totals-row' }, [el('span', {}, 'Subtotal'), el('span', {}, money(totals.subtotal))]),
    totals.discountTotal ? el('div', { class: 'totals-row' }, [el('span', {}, discountLabel ? `${discountLabel} Discount (20%)` : 'Discount'), el('span', {}, `-${money(totals.discountTotal)}`)]) : null,
    totals.vatExemptTotal ? el('div', { class: 'totals-row' }, [el('span', {}, 'VAT-Exempt Sales'), el('span', {}, money(totals.vatExemptTotal))]) : null,
    el('div', { class: 'totals-row' }, [el('span', {}, 'Tax'), el('span', {}, money(totals.taxTotal))]),
    el('div', { class: 'totals-row grand' }, [el('span', {}, 'Total'), el('span', {}, money(totals.total))]),
  ].filter(Boolean));

  const actions = el('div', { class: 'cart-actions' }, [
    el('button', { class: 'btn ghost', onclick: () => { state.cart = []; state.customer = null; state.channel = null; state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false }; refreshProductsForChannel(); } }, 'Clear'),
    el('button', {
      class: 'btn primary', disabled: cart.length === 0 ? 'true' : null,
      onclick: () => openPaymentModal(cartTotals(), completeSale),
    }, 'Charge'),
  ]);

  cartPanelRef.appendChild(header);
  cartPanelRef.appendChild(itemsEl);
  cartPanelRef.appendChild(totalsEl);
  cartPanelRef.appendChild(actions);
}

function changeQty(idx, delta) {
  const cart = window.APP_STATE.cart;
  const line = cart[idx];
  const newQty = line.qty + delta;
  if (newQty <= 0) { cart.splice(idx, 1); refreshCartPanel(); return; }
  if (line.track_stock && newQty > line.stock_qty) { toast(`Only ${line.stock_qty} in stock`, 'error'); return; }
  line.qty = newQty;
  if (line.sc_pwd_eligible_qty > newQty) line.sc_pwd_eligible_qty = newQty;
  refreshCartPanel();
}

function openCustomerPicker(onDone) {
  let results = [];
  const backdrop = el('div', { class: 'modal-backdrop' });
  const searchInput = el('input', { type: 'text', placeholder: 'Search customer by name or phone…' });
  const listEl = el('div', { style: 'margin-top:10px;max-height:240px;overflow-y:auto;' });

  async function search() {
    results = searchInput.value ? await api.get(`/api/customers?q=${encodeURIComponent(searchInput.value)}`) : await api.get('/api/customers');
    listEl.innerHTML = '';
    results.forEach((c) => {
      listEl.appendChild(el('button', { class: 'staff-btn', style: 'width:100%;margin-bottom:6px;', onclick: () => {
        window.APP_STATE.customer = c;
        document.body.removeChild(backdrop);
        onDone();
      } }, [c.name, el('span', { class: 'staff-role' }, c.phone || c.email || '')]));
    });
  }
  searchInput.addEventListener('input', search);
  search();

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Attach Customer'),
    searchInput,
    listEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn ghost', onclick: () => { window.APP_STATE.customer = null; document.body.removeChild(backdrop); onDone(); } }, 'No customer'),
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  searchInput.focus();
}

function openChannelPicker(onDone) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const listEl = el('div', { style: 'margin-top:10px;max-height:280px;overflow-y:auto;' });

  posChannels.forEach((c) => {
    listEl.appendChild(el('button', { class: 'staff-btn', style: 'width:100%;margin-bottom:6px;', onclick: () => {
      window.APP_STATE.channel = c.name === 'Walk-in' ? null : c;
      document.body.removeChild(backdrop);
      onDone();
    } }, [c.name, el('span', { class: 'staff-role' }, c.commission_rate ? `${(c.commission_rate * 100).toFixed(0)}% commission` : 'In-house')]));
  });

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Order Channel'),
    el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:-6px;' }, 'Where this order came from — for FoodPanda/GrabFood, staff key the order in here after it comes through the platform\'s tablet.'),
    listEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

// Defaults eligibility for takeout: only ONE unit of the single
// highest-priced (per-unit) cart line starts out marked, everything else 0
// — since staff can't know which of the ordered items the PWD/senior will
// actually eat, per BIR/DTI guidance the discount defaults to just one unit
// of the most expensive item. This is only a starting point, not an ongoing
// constraint — staff can still check any other dish/quantity afterward.
function selectHighestPriceLine(cart) {
  for (const line of cart) line.sc_pwd_eligible_qty = 0;
  if (cart.length === 0) return;
  let top = cart[0];
  for (const line of cart) if (line.price > top.price) top = line;
  top.sc_pwd_eligible_qty = Math.min(1, top.qty);
}

// Reverses selectHighestPriceLine(): undefined reads as "fully eligible,
// tracks qty" everywhere it's consumed (see computeLine), so un-checking
// takeout after it was applied must clear the restrictive zeros it left
// behind rather than leaving most of the cart stuck ineligible.
function clearEligibilityOverrides(cart) {
  for (const line of cart) line.sc_pwd_eligible_qty = undefined;
}

function openScPwdModal(onDone) {
  const state = window.APP_STATE;
  const current = state.scPwdDiscount;
  let type = current.type !== 'none' ? current.type : 'senior';
  const backdrop = el('div', { class: 'modal-backdrop' });
  const idInput = el('input', { type: 'text', value: current.idNumber || '', placeholder: 'e.g. OSCA/PWD ID number' });
  const nameInput = el('input', { type: 'text', value: current.holderName || '', placeholder: 'Full name on the ID' });
  const takeoutInput = el('input', { type: 'checkbox' });
  takeoutInput.checked = Boolean(current.isTakeout);
  const errorEl = el('div', { class: 'login-error' }, '');

  const typeButtons = el('div', { class: 'tender-methods', style: 'grid-template-columns:repeat(2,1fr);' }, [
    el('button', { class: type === 'senior' ? 'active' : '', onclick: () => { type = 'senior'; renderModal(); } }, 'Senior Citizen'),
    el('button', { class: type === 'pwd' ? 'active' : '', onclick: () => { type = 'pwd'; renderModal(); } }, 'PWD'),
  ]);

  function renderModal() {
    backdrop.innerHTML = '';
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Senior Citizen / PWD Discount'),
      el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:-6px;' }, '20% discount + VAT exemption per RA 9994 / RA 10754. Check off in the cart exactly which items the cardholder is actually consuming — for a dine-in order that\'s usually everything; uncheck anything a companion is eating instead.'),
      typeButtons,
      el('div', { class: 'field', style: 'margin-top:10px;' }, [el('label', {}, `${type === 'senior' ? 'OSCA' : 'PWD'} ID Number`), idInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Cardholder Name'), nameInput]),
      el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;margin-top:4px;' }, [
        takeoutInput,
        '🥡 Takeout — we can\'t know what the cardholder eats, so only the single most expensive item qualifies',
      ]),
      errorEl,
      el('div', { class: 'modal-actions' }, [
        current.type !== 'none' ? el('button', { class: 'btn ghost', onclick: () => {
          state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false };
          document.body.removeChild(backdrop);
          onDone();
        } }, 'Remove Discount') : null,
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => {
          if (!idInput.value.trim() || !nameInput.value.trim()) { errorEl.textContent = 'ID number and name are required'; return; }
          const isTakeout = takeoutInput.checked;
          state.scPwdDiscount = { type, idNumber: idInput.value.trim(), holderName: nameInput.value.trim(), isTakeout };
          // Switching to dine-in (incl. reversing a previous takeout
          // selection) must restore full eligibility, not just leave
          // whatever takeout's zeros left behind.
          if (isTakeout) selectHighestPriceLine(state.cart);
          else clearEligibilityOverrides(state.cart);
          document.body.removeChild(backdrop);
          onDone();
        } }, 'Apply'),
      ].filter(Boolean)),
    ]);
    backdrop.appendChild(modal);
  }

  renderModal();
  document.body.appendChild(backdrop);
}

// totals: { total } at minimum. onComplete(finalPayments, backdrop) is
// called with the assembled payment list and must close the modal itself
// (via document.body.removeChild(backdrop)) once done. Shared by the
// register's immediate checkout and the table order "Bill Out" flow.
function openPaymentModal(totals, onComplete) {
  let method = 'cash';
  let cashTendered = Math.round(totals.total * 100) / 100;
  let reference = '';
  const payments = [];

  const backdrop = el('div', { class: 'modal-backdrop' });
  const errorEl = el('div', { class: 'login-error' }, '');

  function quickCashOptions() {
    const base = Math.ceil(totals.total / 50) * 50;
    return [...new Set([totals.total, base, base + 50, base + 100, Math.ceil(totals.total / 100) * 100])].filter((v) => v >= totals.total);
  }

  function renderModal() {
    backdrop.innerHTML = '';
    const remaining = totals.total - payments.reduce((s, p) => s + p.amount, 0);

    const body = [
      el('h3', {}, `Charge ${money(totals.total)}`),
      el('div', { class: 'tender-methods' }, ['cash', 'card', 'gcash', 'maya', 'other'].map((m) =>
        el('button', { class: method === m ? 'active' : '', onclick: () => { method = m; renderModal(); } }, m.toUpperCase())
      )),
    ];

    if (method === 'cash') {
      body.push(
        el('div', { class: 'field' }, [
          el('label', {}, 'Cash Tendered'),
          (() => {
            const input = el('input', { type: 'number', step: '0.01', value: String(cashTendered) });
            input.addEventListener('input', () => { cashTendered = Number(input.value) || 0; });
            return input;
          })(),
        ]),
        el('div', { class: 'quick-cash' }, quickCashOptions().map((v) =>
          el('button', { onclick: () => { cashTendered = v; renderModal(); } }, money(v))
        ))
      );
    } else {
      body.push(el('div', { class: 'field' }, [
        el('label', {}, `${method.toUpperCase()} Reference / Approval Code (optional)`),
        (() => {
          const input = el('input', { type: 'text', value: reference, placeholder: 'e.g. auth code, ref number' });
          input.addEventListener('input', () => { reference = input.value; });
          return input;
        })(),
      ]));
    }

    if (payments.length > 0) {
      body.push(el('div', { class: 'payment-list' }, [
        ...payments.map((p, idx) => el('div', { class: 'row' }, [
          el('span', {}, `${p.method.toUpperCase()}${p.reference ? ' (' + p.reference + ')' : ''}`),
          el('span', {}, `${money(p.amount)}  `),
        ])),
        el('div', { class: 'row' }, [el('strong', {}, 'Remaining'), el('strong', {}, money(Math.max(0, remaining)))]),
      ]));
    }

    body.push(errorEl);

    const actions = [];
    if (remaining > 0.004) {
      actions.push(el('button', {
        class: 'btn ghost',
        onclick: () => {
          const amt = method === 'cash' ? Math.min(cashTendered, remaining) : remaining;
          if (amt <= 0) { errorEl.textContent = 'Enter a valid amount'; return; }
          payments.push({ method, amount: Number(amt.toFixed(2)), tendered: method === 'cash' ? cashTendered : amt, reference });
          reference = '';
          renderModal();
        },
      }, `Add ${method === 'cash' ? 'partial' : 'split'} payment`));
    }

    actions.push(el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'));
    actions.push(el('button', {
      class: 'btn primary',
      onclick: async () => {
        let finalPayments = payments.slice();
        if (remaining > 0.004) {
          const amt = method === 'cash' ? cashTendered : remaining;
          if (method === 'cash' && amt < remaining) { errorEl.textContent = 'Cash tendered is less than the amount due'; return; }
          finalPayments.push({ method, amount: method === 'cash' ? remaining : remaining, tendered: method === 'cash' ? cashTendered : amt, reference });
        }
        await onComplete(finalPayments, backdrop);
      },
    }, 'Complete Sale'));

    const modal = el('div', { class: 'modal' }, [...body, el('div', { class: 'modal-actions' }, actions)]);
    backdrop.appendChild(modal);
  }

  renderModal();
  document.body.appendChild(backdrop);
}

async function completeSale(payments, backdrop) {
  const state = window.APP_STATE;
  const items = state.cart.map((l) => ({
    product_id: l.product_id, name: l.name, price: l.price, qty: l.qty, discount: l.discount, tax_rate: l.tax_rate,
    // undefined here means "fully eligible" (see computeLine) — resolve it
    // to a concrete number before sending since the server has no concept
    // of "tracks qty", only an explicit eligible count.
    sc_pwd_eligible_qty: l.sc_pwd_eligible_qty ?? l.qty,
  }));
  try {
    const sale = await api.post('/api/sales/checkout', {
      items, payments, customer_id: state.customer ? state.customer.id : null,
      channel_id: state.channel ? state.channel.id : null,
      discount_type: state.scPwdDiscount.type,
      discount_id_number: state.scPwdDiscount.idNumber,
      discount_holder_name: state.scPwdDiscount.holderName,
    });
    document.body.removeChild(backdrop);
    state.cart = [];
    state.customer = null;
    state.channel = null;
    state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false };
    await refreshProductsForChannel();
    toast(`Sale ${sale.sale_number} completed`, 'success');
    await openReceiptModal(sale.id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function buildPrintableReceiptDom(r) {
  const text = formatReceiptText(r);
  return el('div', { class: 'print-receipt' }, [
    r.storeLogo ? el('img', { class: 'receipt-logo', src: r.storeLogo, alt: r.storeName }) : null,
    el('pre', {}, text),
  ].filter(Boolean));
}

async function openReceiptModal(saleId) {
  const receipt = await api.get(`/api/sales/${saleId}/receipt`);
  const text = formatReceiptText(receipt);

  const backdrop = el('div', { class: 'modal-backdrop' });
  const printNode = buildPrintableReceiptDom(receipt);
  const emailInput = el('input', { type: 'email', placeholder: 'customer@email.com', value: receipt.customerEmail || '' });

  function close() {
    document.body.removeChild(backdrop);
    document.body.removeChild(printNode);
  }

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Receipt'),
    receipt.storeLogo ? el('img', { src: receipt.storeLogo, alt: receipt.storeName, style: 'max-width:100px;max-height:100px;display:block;margin:0 auto 10px;object-fit:contain;' }) : null,
    el('div', { class: 'receipt-preview' }, text),
    el('div', { class: 'field' }, [
      el('label', {}, 'Email receipt to'),
      emailInput,
    ]),
    el('div', { class: 'modal-actions', style: 'flex-wrap:wrap;justify-content:flex-start;' }, [
      el('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print (browser)'),
      el('button', { class: 'btn', onclick: async () => {
        try { await api.post(`/api/sales/${saleId}/receipt/print`); toast('Sent to thermal printer', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      } }, '🧾 Print (thermal)'),
      el('button', { class: 'btn', onclick: async () => {
        try { await api.post(`/api/sales/${saleId}/receipt/email`, { email: emailInput.value }); toast('Receipt emailed', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      } }, '✉ Email'),
      el('button', { class: 'btn primary', onclick: close }, 'Done'),
    ]),
  ].filter(Boolean));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  document.body.appendChild(printNode);
}

function formatReceiptText(r) {
  // Matches the width the thermal-print path uses for the same setting
  // (server/routes/sales.js) — otherwise browser-printed/previewed receipts
  // stay 58mm-formatted even when Settings is configured for 80mm paper.
  const settings = window.APP_STATE && window.APP_STATE.settings;
  const width = settings && settings.receipt_paper_width === '80mm' ? 42 : 32;
  const line = '-'.repeat(width);
  const pad = (l, right) => l + ' '.repeat(Math.max(1, width - l.length - right.length)) + right;
  let out = `${r.storeName}\n`;
  if (r.storeAddress) out += `${r.storeAddress}\n`;
  if (r.storePhone) out += `${r.storePhone}\n`;
  if (r.storeTin) out += `TIN: ${r.storeTin}\n`;
  out += line + '\n';
  out += `Receipt: ${r.saleNumber}\nDate: ${r.createdAt}\nCashier: ${r.cashierName}\n`;
  if (r.tableName) out += `Table: ${r.tableName}\n`;
  if (r.customerName) out += `Customer: ${r.customerName}\n`;
  out += line + '\n';
  for (const i of r.items) {
    out += `${i.name}\n`;
    out += pad(`${i.qty} x ${i.price.toFixed(2)}`, i.lineTotal.toFixed(2)) + '\n';
  }
  out += line + '\n';
  out += pad('Subtotal', r.subtotal.toFixed(2)) + '\n';
  const discLabel = r.discountType === 'senior' ? 'Senior Citizen Disc. (20%)' : r.discountType === 'pwd' ? 'PWD Discount (20%)' : 'Discount';
  if (r.discountTotal) out += pad(discLabel, '-' + r.discountTotal.toFixed(2)) + '\n';
  if (r.vatExemptTotal) out += pad('VAT-Exempt Sales', r.vatExemptTotal.toFixed(2)) + '\n';
  if (r.taxTotal) out += pad('Tax', r.taxTotal.toFixed(2)) + '\n';
  out += pad('TOTAL', r.total.toFixed(2)) + '\n';
  out += line + '\n';
  for (const p of r.payments) {
    out += pad(p.method.toUpperCase(), p.amount.toFixed(2)) + '\n';
    if (p.changeGiven) out += pad('Change', p.changeGiven.toFixed(2)) + '\n';
  }
  if (r.discountType && r.discountType !== 'none') {
    out += line + '\n';
    out += `${r.discountType === 'senior' ? 'SC' : 'PWD'} ID#: ${r.discountIdNumber || ''}\n`;
    out += `Name: ${r.discountHolderName || ''}\n`;
  }
  out += line + '\n';
  out += r.footer || 'Thank you!';
  return out;
}
