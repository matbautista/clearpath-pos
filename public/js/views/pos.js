let posProducts = [];
let posCategories = [];
let posActiveCategory = null;
let posChannels = [];

async function renderPosView(container) {
  container.innerHTML = '';
  const state = window.APP_STATE;

  try {
    [posProducts, posCategories, state.shift, posChannels] = await Promise.all([
      api.get('/api/products?active=true'),
      api.get('/api/categories'),
      api.get('/api/shifts/current'),
      api.get('/api/channels?active=true'),
    ]);
  } catch (e) {
    toast(e.message, 'error');
  }

  if (!state.shift) {
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
      grid.appendChild(el('button', {
        class: `product-tile ${outOfStock ? 'out' : ''}`,
        style: productTileStyle(p),
        disabled: outOfStock ? 'true' : null,
        onclick: () => addToCart(p),
      }, [
        el('div', { class: 'name' }, p.name),
        el('div', {}, [
          el('div', { class: 'price' }, money(p.price)),
          el('div', { class: 'stock' }, p.track_stock ? `${p.stock_qty} in stock` : ''),
        ]),
      ]));
    }
  }
  refreshGrid();

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
  const existing = state.cart.find((l) => l.product_id === product.id);
  if (existing) {
    if (product.track_stock && existing.qty + 1 > product.stock_qty) {
      toast(`Only ${product.stock_qty} in stock`, 'error');
      return;
    }
    existing.qty += 1;
  } else {
    if (product.track_stock && product.stock_qty <= 0) { toast('Out of stock', 'error'); return; }
    state.cart.push({
      product_id: product.id, name: product.name, price: product.price,
      tax_rate: product.tax_rate, qty: 1, discount: 0, track_stock: product.track_stock, stock_qty: product.stock_qty,
      sc_pwd_eligible: true,
    });
  }
  refreshCartPanel();
}

// Mirrors the checkout math in server/routes/sales.js: RA 9994 (Senior
// Citizens) / RA 10754 (PWD) mandate 20% off the VAT-exclusive price, with
// the sale becoming VAT-exempt, for lines marked eligible.
function computeLine(line) {
  const scPwdActive = window.APP_STATE.scPwdDiscount.type !== 'none' && line.sc_pwd_eligible;
  const gross = line.price * line.qty - line.discount;
  if (scPwdActive) {
    const vatExclusive = gross / (1 + line.tax_rate);
    const vatExemptAmount = gross - vatExclusive;
    const scPwdDiscount = vatExclusive * 0.2;
    return { taxAmount: 0, vatExemptAmount, lineDiscount: line.discount + scPwdDiscount, lineTotal: vatExclusive - scPwdDiscount };
  }
  const taxAmount = gross * line.tax_rate;
  return { taxAmount, vatExemptAmount: 0, lineDiscount: line.discount, lineTotal: gross + taxAmount };
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
      }, discountLabel ? `🎫 ${discountLabel}` : '🎫 SC/PWD'),
      el('button', { class: 'btn ghost small', onclick: () => { state.customer = null; openCustomerPicker(refreshCartPanel); } }, state.customer ? state.customer.name : '+ Customer'),
      el('button', { class: 'btn ghost small', onclick: () => openChannelPicker(refreshCartPanel) }, `🛵 ${state.channel ? state.channel.name : 'Walk-in'}`),
    ]),
  ]);

  const itemsEl = el('div', { class: 'cart-items' });
  if (cart.length === 0) {
    itemsEl.appendChild(el('div', { class: 'cart-empty' }, 'Cart is empty. Tap a product or scan a barcode.'));
  } else {
    cart.forEach((line, idx) => {
      const c = computeLine(line);
      const eligibilityToggle = discountLabel
        ? el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);white-space:nowrap;' }, [
            (() => {
              const cb = el('input', { type: 'checkbox' });
              cb.checked = Boolean(line.sc_pwd_eligible);
              cb.addEventListener('change', () => { line.sc_pwd_eligible = cb.checked; refreshCartPanel(); });
              return cb;
            })(),
            discountLabel,
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
    el('button', { class: 'btn ghost', onclick: () => { state.cart = []; state.customer = null; state.channel = null; state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '' }; refreshCartPanel(); } }, 'Clear'),
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

function openScPwdModal(onDone) {
  const state = window.APP_STATE;
  const current = state.scPwdDiscount;
  let type = current.type !== 'none' ? current.type : 'senior';
  const backdrop = el('div', { class: 'modal-backdrop' });
  const idInput = el('input', { type: 'text', value: current.idNumber || '', placeholder: 'e.g. OSCA/PWD ID number' });
  const nameInput = el('input', { type: 'text', value: current.holderName || '', placeholder: 'Full name on the ID' });
  const errorEl = el('div', { class: 'login-error' }, '');

  const typeButtons = el('div', { class: 'tender-methods', style: 'grid-template-columns:repeat(2,1fr);' }, [
    el('button', { class: type === 'senior' ? 'active' : '', onclick: () => { type = 'senior'; renderModal(); } }, 'Senior Citizen'),
    el('button', { class: type === 'pwd' ? 'active' : '', onclick: () => { type = 'pwd'; renderModal(); } }, 'PWD'),
  ]);

  function renderModal() {
    backdrop.innerHTML = '';
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Senior Citizen / PWD Discount'),
      el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:-6px;' }, '20% discount + VAT exemption per RA 9994 / RA 10754. Uncheck any line items in the cart that don’t qualify (e.g. alcohol, tobacco).'),
      typeButtons,
      el('div', { class: 'field', style: 'margin-top:10px;' }, [el('label', {}, `${type === 'senior' ? 'OSCA' : 'PWD'} ID Number`), idInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Cardholder Name'), nameInput]),
      errorEl,
      el('div', { class: 'modal-actions' }, [
        current.type !== 'none' ? el('button', { class: 'btn ghost', onclick: () => {
          state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '' };
          document.body.removeChild(backdrop);
          onDone();
        } }, 'Remove Discount') : null,
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => {
          if (!idInput.value.trim() || !nameInput.value.trim()) { errorEl.textContent = 'ID number and name are required'; return; }
          state.scPwdDiscount = { type, idNumber: idInput.value.trim(), holderName: nameInput.value.trim() };
          for (const line of state.cart) if (line.sc_pwd_eligible === undefined) line.sc_pwd_eligible = true;
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
    sc_pwd_eligible: Boolean(l.sc_pwd_eligible),
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
    state.scPwdDiscount = { type: 'none', idNumber: '', holderName: '' };
    refreshCartPanel();
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
