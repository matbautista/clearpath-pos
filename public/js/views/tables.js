let tablesProducts = [];
let tablesCategories = [];

async function renderTablesView(container) {
  container.innerHTML = '';
  const state = window.APP_STATE;
  const user = state.user;
  // Only a cashier needs their own open cash drawer shift — the only role
  // that actually charges anything here. Waiters have no cash-drawer access
  // at all, so /api/shifts/current would 403 for them — skip it entirely
  // for anyone but a cashier.
  if (user.role === 'cashier') {
    state.shift = await api.get('/api/shifts/current');
    if (!state.shift) {
      container.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:center;height:calc(100vh - 40px);' }, [
        el('div', { class: 'card', style: 'max-width:420px;text-align:center;padding:32px;' }, [
          el('div', { style: 'font-size:32px;margin-bottom:8px;' }, '🗄️'),
          el('h2', { style: 'margin:0 0 8px;' }, 'No Shift Open'),
          el('p', { style: 'color:var(--text-muted);font-size:14px;margin-bottom:20px;' },
            'You need to open a cash drawer shift before starting or billing any table order.'),
          el('button', { class: 'btn primary', onclick: () => navigate('shift') }, 'Open Shift'),
        ]),
      ]));
      return;
    }
  }

  const tables = await api.get('/api/tables');

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Tables'),
    ['admin', 'manager'].includes(user.role)
      ? el('button', { class: 'btn ghost', onclick: () => openManageTablesModal(() => renderTablesView(container)) }, 'Manage Tables')
      : null,
  ].filter(Boolean));

  const grid = el('div', { class: 'product-grid' });
  if (tables.length === 0) {
    grid.appendChild(el('div', { class: 'empty-state' }, 'No tables yet. Use "Manage Tables" to add some.'));
  }
  tables.forEach((t) => {
    const occupied = Boolean(t.open_sale);
    // shift_id is null either because the order's original shift closed
    // while it was still open (a real hand-off — see /shifts/:id/close), or
    // because it was opened by an admin/manager, who aren't required to have
    // one at all. Either way there's no shift claiming it yet, so the label
    // stays neutral rather than assuming a hand-off happened.
    const noShift = occupied && t.open_sale.shift_id === null;
    grid.appendChild(el('button', {
      class: 'product-tile',
      style: `background:${occupied ? '#e0473f' : '#1ea672'};min-height:100px;`,
      onclick: () => renderTableOrderScreen(container, t),
    }, [
      el('div', { class: 'name', style: 'font-size:16px;' }, [
        t.name,
        noShift ? el('span', { style: 'margin-left:6px;font-size:11px;' }, '⏳') : null,
      ].filter(Boolean)),
      el('div', {}, [
        el('div', { class: 'price' }, occupied ? money(t.open_sale.total) : 'Available'),
        el('div', { class: 'stock' }, occupied ? (noShift ? `${t.open_sale.item_count} item(s) · no shift` : `${t.open_sale.item_count} item(s) · open`) : ''),
      ]),
    ]));
  });

  container.appendChild(header);
  container.appendChild(grid);
}

function openManageTablesModal(onDone) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const nameInput = el('input', { type: 'text', placeholder: 'New table name (e.g. Table 7)' });
  const listEl = el('div', { style: 'margin:10px 0;max-height:260px;overflow-y:auto;' });

  async function refresh() {
    const tables = await api.get('/api/tables');
    listEl.innerHTML = '';
    tables.forEach((t) => {
      listEl.appendChild(el('div', { class: 'totals-row' }, [
        el('span', {}, t.name + (t.open_sale ? ' (occupied)' : '')),
        el('button', { class: 'btn small danger', onclick: async () => {
          try { await api.del(`/api/tables/${t.id}`); refresh(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Remove'),
      ]));
    });
  }
  refresh();

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Manage Tables'),
    listEl,
    el('div', { class: 'field' }, [nameInput]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => { document.body.removeChild(backdrop); onDone(); } }, 'Close'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!nameInput.value.trim()) return;
        try { await api.post('/api/tables', { name: nameInput.value.trim() }); nameInput.value = ''; refresh(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Add'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

async function renderTableOrderScreen(container, table) {
  container.innerHTML = '';
  // cashier can build the order and bill it; waiter can build it but never
  // bill; admin/manager are read-only ("view only, not able to transact").
  const capability = orderCapability(window.APP_STATE.user.role);
  const canBuild = capability !== 'view';
  const canCharge = capability === 'full';
  let openOrder = await api.get(`/api/sales/table/${table.id}/open`);
  let newItems = []; // this round, not sent yet: { product_id, name, price, tax_rate, qty, notes }
  let orderDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false };
  let orderCustomer = null;
  const eligibility = {}; // sale_item_id -> eligible qty (0..item.qty), used only once billing starts

  [tablesProducts, tablesCategories] = await Promise.all([
    api.get('/api/products?active=true'),
    api.get('/api/categories'),
  ]);
  let activeCategory = null;

  const scanInput = el('input', {
    type: 'text',
    placeholder: canBuild ? 'Scan barcode or type SKU, then press Enter…' : 'View only',
    disabled: canBuild ? null : 'true',
  });
  scanInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && scanInput.value.trim()) {
      await handleTableBarcode(scanInput.value.trim());
      scanInput.value = '';
    }
  });

  const categoryTabs = el('div', { class: 'category-tabs' }, [
    el('button', { class: activeCategory === null ? 'active' : '', onclick: () => { activeCategory = null; refreshProductGrid(); } }, 'All'),
    ...tablesCategories.map((c) => el('button', {
      class: activeCategory === c.id ? 'active' : '',
      onclick: () => { activeCategory = c.id; refreshProductGrid(); },
    }, c.name)),
  ]);

  const productGrid = el('div', { class: 'product-grid' });
  function refreshProductGrid() {
    productGrid.innerHTML = '';
    const items = tablesProducts.filter((p) => activeCategory === null || p.category_id === activeCategory);
    for (const p of items) {
      const outOfStock = p.track_stock && p.stock_qty <= 0;
      const disabled = outOfStock || !canBuild;
      productGrid.appendChild(el('button', {
        class: `product-tile ${disabled ? 'out' : ''}`,
        style: productTileStyle(p),
        disabled: disabled ? 'true' : null,
        onclick: canBuild ? () => addNewItem(p) : null,
      }, [
        el('div', { class: 'name' }, p.name),
        el('div', {}, [
          el('div', { class: 'price' }, money(p.price)),
          el('div', { class: 'stock' }, p.track_stock ? `${p.stock_qty} in stock` : ''),
        ]),
      ]));
    }
  }
  refreshProductGrid();

  async function handleTableBarcode(code) {
    const local = tablesProducts.find((p) => p.barcode === code || p.sku === code);
    if (local) { addNewItem(local); return; }
    try {
      const p = await api.get(`/api/products/barcode/${encodeURIComponent(code)}`);
      addNewItem(p);
    } catch (e) {
      toast(`No product found for "${code}"`, 'error');
    }
  }

  function addNewItem(product) {
    const existing = newItems.find((l) => l.product_id === product.id && !l.notes);
    if (existing) {
      existing.qty += 1;
    } else {
      const takeoutActive = orderDiscount.type !== 'none' && orderDiscount.isTakeout;
      // undefined means "fully eligible, tracks qty" (the dine-in default),
      // so tapping the same product again to bump qty keeps the whole line
      // eligible without extra bookkeeping here.
      newItems.push({ product_id: product.id, name: product.name, price: product.price, tax_rate: product.tax_rate, qty: 1, notes: '', sc_pwd_eligible_qty: takeoutActive ? 0 : undefined });
    }
    refreshOrderPanel();
  }

  // Mirrors computeSaleLine() in server/routes/sales.js for a live preview. A
  // line can be partially eligible (e.g. 2 of 3 units consumed by the
  // cardholder) — split it into an eligible sub-quantity and a regular
  // sub-quantity and sum their results.
  function computeSubtotal(price, qty, taxRate, scPwdEligible) {
    const gross = price * qty;
    if (scPwdEligible) {
      const vatExclusive = gross / (1 + taxRate);
      const vatExemptAmount = gross - vatExclusive;
      const scPwdDiscount = vatExclusive * 0.2;
      return { taxAmount: 0, vatExemptAmount, discount: scPwdDiscount, lineTotal: vatExclusive - scPwdDiscount };
    }
    const taxAmount = gross * taxRate;
    return { taxAmount, vatExemptAmount: 0, discount: 0, lineTotal: gross + taxAmount };
  }

  // Sent-to-kitchen lines carry their eligible qty in `eligibility[item.id]`;
  // this round's unsent drafts (no `.id` yet) carry it directly on
  // `item.sc_pwd_eligible_qty` — same "missing means fully eligible,
  // tracks qty" default either way.
  function eligibleQtyFor(item) {
    return item.id !== undefined ? (eligibility[item.id] ?? item.qty) : (item.sc_pwd_eligible_qty ?? item.qty);
  }

  function computeBillLine(item) {
    const scPwdActive = orderDiscount.type !== 'none';
    const eligibleQty = scPwdActive ? Math.max(0, Math.min(eligibleQtyFor(item), item.qty)) : 0;
    const regularQty = item.qty - eligibleQty;
    const elig = computeSubtotal(item.price, eligibleQty, item.tax_rate, true);
    const reg = computeSubtotal(item.price, regularQty, item.tax_rate, false);
    return {
      taxAmount: elig.taxAmount + reg.taxAmount,
      vatExemptAmount: elig.vatExemptAmount + reg.vatExemptAmount,
      discount: elig.discount + reg.discount,
      lineTotal: elig.lineTotal + reg.lineTotal,
    };
  }

  function computeLineTotals(items) {
    let subtotal = 0, discountTotal = 0, taxTotal = 0, vatExemptTotal = 0;
    for (const i of items) {
      const c = computeBillLine(i);
      subtotal += i.price * i.qty;
      discountTotal += c.discount;
      taxTotal += c.taxAmount;
      vatExemptTotal += c.vatExemptAmount;
    }
    const total = subtotal - discountTotal - vatExemptTotal + taxTotal;
    return { subtotal, discountTotal, taxTotal, vatExemptTotal, total };
  }

  function billTotals() {
    const items = openOrder ? openOrder.items.filter((i) => !i.voided) : [];
    return computeLineTotals(items);
  }

  // Every eligible-for-discount item currently on the order — sent-to-kitchen
  // lines (keyed by sale_item id in `eligibility`) plus this round's unsent
  // drafts (keyed on the line object itself).
  function allOrderLines() {
    return [...(openOrder ? openOrder.items.filter((i) => !i.voided) : []), ...newItems];
  }

  // Defaults eligibility for takeout: only ONE unit of the single
  // highest-priced (per-unit) item across the whole order — sent or not —
  // starts out marked, everything else 0, since staff can't know which item
  // the PWD/senior will actually eat. Mirrors selectHighestPriceLine() in
  // pos.js. This is only a starting point, not an ongoing constraint — staff
  // can still check any other dish/quantity afterward.
  function selectHighestPriceEligible() {
    for (const i of (openOrder ? openOrder.items.filter((i) => !i.voided) : [])) eligibility[i.id] = 0;
    for (const l of newItems) l.sc_pwd_eligible_qty = 0;
    const lines = allOrderLines();
    if (lines.length === 0) return;
    let top = lines[0];
    for (const l of lines) if (l.price > top.price) top = l;
    const qty = Math.min(1, top.qty);
    if (top.id !== undefined) eligibility[top.id] = qty;
    else top.sc_pwd_eligible_qty = qty;
  }

  // Reverses selectHighestPriceEligible(): a missing eligibility[id] /
  // undefined sc_pwd_eligible_qty reads as "fully eligible, tracks qty"
  // everywhere it's consumed, so un-checking takeout after it was applied
  // must clear the restrictive zeros it left behind rather than leaving
  // most of the order stuck ineligible.
  function clearEligibilityOverrides() {
    for (const i of (openOrder ? openOrder.items.filter((i) => !i.voided) : [])) delete eligibility[i.id];
    for (const l of newItems) l.sc_pwd_eligible_qty = undefined;
  }

  const orderPanelRef = el('div', { class: 'pos-right' });

  function refreshOrderPanel() {
    orderPanelRef.innerHTML = '';
    const discountLabel = orderDiscount.type === 'senior' ? 'Senior' : orderDiscount.type === 'pwd' ? 'PWD' : null;

    const panelHeader = el('div', { class: 'cart-header' }, [
      el('h3', {}, table.name),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;' }, [
        el('button', {
          class: `btn small ${discountLabel ? '' : 'ghost'}`,
          style: discountLabel ? 'background:#1ea672;border-color:#1ea672;color:#fff;' : '',
          disabled: canBuild ? null : 'true',
          onclick: canBuild ? () => openTableScPwdModal() : null,
        }, discountLabel ? `🎫 ${discountLabel}${orderDiscount.isTakeout ? ' 🥡' : ''}` : '🎫 SC/PWD'),
        el('button', {
          class: 'btn ghost small',
          disabled: canBuild ? null : 'true',
          onclick: canBuild ? () => openTableCustomerPicker((c) => { orderCustomer = c; refreshOrderPanel(); }) : null,
        }, orderCustomer ? orderCustomer.name : '+ Customer'),
      ]),
    ]);

    const sentItems = openOrder ? openOrder.items.filter((i) => !i.voided) : [];
    const itemsEl = el('div', { class: 'cart-items' });
    if (sentItems.length === 0 && newItems.length === 0) {
      itemsEl.appendChild(el('div', { class: 'cart-empty' }, 'No items yet. Tap a product to start the order.'));
    }
    if (sentItems.length) {
      itemsEl.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin:6px 4px 2px;' }, 'Sent to kitchen'));
      sentItems.forEach((line) => {
        // Any dish, any quantity can carry the discount — checkboxes are
        // independent. A qty-1 line is a plain checkbox; a qty>1 line gets a
        // number input so staff can pick exactly how many units qualify.
        const eligToggle = discountLabel ? el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);white-space:nowrap;' }, [
          (() => {
            // A missing eligibility[line.id] means "fully eligible, tracks
            // qty" (the dine-in default) — only an explicit number (incl. 0)
            // overrides that.
            if (line.qty <= 1) {
              const cb = el('input', { type: 'checkbox' });
              cb.checked = (eligibility[line.id] ?? line.qty) >= 1;
              cb.addEventListener('change', () => { eligibility[line.id] = cb.checked ? 1 : 0; refreshOrderPanel(); });
              return cb;
            }
            const numInput = el('input', { type: 'number', min: '0', max: String(line.qty), step: '1', value: String(eligibility[line.id] ?? line.qty), style: 'width:42px;padding:2px 4px;' });
            numInput.addEventListener('input', () => {
              eligibility[line.id] = Math.max(0, Math.min(line.qty, Number(numInput.value) || 0));
              refreshOrderPanel();
            });
            return numInput;
          })(),
          line.qty <= 1 ? discountLabel : `/${line.qty} ${discountLabel}`,
        ]) : null;
        itemsEl.appendChild(el('div', { class: 'cart-item' }, [
          el('div', { class: 'info' }, [
            el('div', { class: 'name' }, line.name + (line.notes ? ` — ${line.notes}` : '')),
            el('div', { class: 'price' }, `${line.qty} x ${money(line.price)}`),
          ]),
          eligToggle,
          el('div', { class: 'qty-control' }, [
            el('button', { disabled: canBuild ? null : 'true', onclick: canBuild ? () => editSentItem(line, line.qty - 1) : null }, '−'),
            el('span', {}, String(line.qty)),
            el('button', { disabled: canBuild ? null : 'true', onclick: canBuild ? () => editSentItem(line, line.qty + 1) : null }, '+'),
          ]),
          el('div', { class: 'line-total' }, money(discountLabel ? computeBillLine(line).lineTotal : line.line_total)),
          canBuild ? el('button', { class: 'remove-line', title: 'Remove item', onclick: () => editSentItem(line, 0) }, '✕') : null,
        ].filter(Boolean)));
      });
    }
    if (newItems.length) {
      itemsEl.appendChild(el('div', { style: 'font-size:11px;color:var(--primary);font-weight:700;text-transform:uppercase;margin:10px 4px 2px;' }, 'This round — not sent yet'));
      newItems.forEach((line, idx) => {
        const notesInput = el('input', { type: 'text', placeholder: 'note (e.g. no onions)', value: line.notes, style: 'font-size:12px;padding:5px 8px;' });
        notesInput.addEventListener('input', () => { line.notes = notesInput.value; });
        const eligToggle = discountLabel ? el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);white-space:nowrap;' }, [
          (() => {
            // A missing sc_pwd_eligible_qty means "fully eligible, tracks
            // qty" (the dine-in default) — only an explicit number (incl. 0)
            // overrides that.
            if (line.qty <= 1) {
              const cb = el('input', { type: 'checkbox' });
              cb.checked = (line.sc_pwd_eligible_qty ?? line.qty) >= 1;
              cb.addEventListener('change', () => { line.sc_pwd_eligible_qty = cb.checked ? 1 : 0; refreshOrderPanel(); });
              return cb;
            }
            const numInput = el('input', { type: 'number', min: '0', max: String(line.qty), step: '1', value: String(line.sc_pwd_eligible_qty ?? line.qty), style: 'width:42px;padding:2px 4px;' });
            numInput.addEventListener('input', () => {
              line.sc_pwd_eligible_qty = Math.max(0, Math.min(line.qty, Number(numInput.value) || 0));
              refreshOrderPanel();
            });
            return numInput;
          })(),
          line.qty <= 1 ? discountLabel : `/${line.qty} ${discountLabel}`,
        ]) : null;
        itemsEl.appendChild(el('div', { class: 'cart-item', style: 'flex-direction:column;align-items:stretch;gap:5px;' }, [
          el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
            el('div', { class: 'info' }, [el('div', { class: 'name' }, line.name)]),
            eligToggle,
            el('div', { class: 'qty-control' }, [
              el('button', { onclick: () => {
                if (line.qty > 1) { line.qty--; if (line.sc_pwd_eligible_qty > line.qty) line.sc_pwd_eligible_qty = line.qty; }
                else newItems.splice(idx, 1);
                refreshOrderPanel();
              } }, '−'),
              el('span', {}, String(line.qty)),
              el('button', { onclick: () => { line.qty++; refreshOrderPanel(); } }, '+'),
            ]),
            el('div', { class: 'line-total' }, money(discountLabel ? computeBillLine(line).lineTotal : line.price * line.qty)),
            el('button', { class: 'remove-line', onclick: () => { newItems.splice(idx, 1); refreshOrderPanel(); } }, '✕'),
          ].filter(Boolean)),
          notesInput,
        ]));
      });
    }

    const totals = billTotals();
    const newTotals = computeLineTotals(newItems);
    const grandTotal = totals.total + newTotals.total;

    const totalsEl = el('div', { class: 'cart-totals' }, [
      sentItems.length ? el('div', { class: 'totals-row' }, [el('span', {}, 'Sent to kitchen'), el('span', {}, money(totals.total))]) : null,
      (totals.discountTotal + newTotals.discountTotal) ? el('div', { class: 'totals-row' }, [el('span', {}, `${discountLabel} Discount (20%)`), el('span', {}, `-${money(totals.discountTotal + newTotals.discountTotal)}`)]) : null,
      (totals.vatExemptTotal + newTotals.vatExemptTotal) ? el('div', { class: 'totals-row' }, [el('span', {}, 'VAT-Exempt Sales'), el('span', {}, money(totals.vatExemptTotal + newTotals.vatExemptTotal))]) : null,
      newItems.length ? el('div', { class: 'totals-row' }, [el('span', {}, 'This round'), el('span', {}, money(newTotals.total))]) : null,
      el('div', { class: 'totals-row grand' }, [el('span', {}, 'Order Total'), el('span', {}, money(grandTotal))]),
    ].filter(Boolean));

    const actions = el('div', { class: 'cart-actions', style: 'flex-wrap:wrap;' }, [
      el('button', {
        class: 'btn ghost', disabled: (!canBuild || newItems.length === 0) ? 'true' : null,
        onclick: () => { newItems = []; refreshOrderPanel(); },
      }, 'Clear Round'),
      el('button', {
        class: 'btn primary', disabled: (!canBuild || newItems.length === 0) ? 'true' : null,
        onclick: sendToKitchen,
      }, '🍳 Send to Kitchen'),
      el('button', {
        class: 'btn success', disabled: (!canCharge || sentItems.length === 0 || newItems.length > 0) ? 'true' : null,
        onclick: billOut,
      }, '💳 Bill Out'),
    ]);

    orderPanelRef.appendChild(panelHeader);
    orderPanelRef.appendChild(itemsEl);
    orderPanelRef.appendChild(totalsEl);
    orderPanelRef.appendChild(actions);
  }

  // Edits or removes (qty 0) a line item already sent to the kitchen.
  // Always requires an admin PIN to confirm, even if the current user is
  // already logged in as admin — this is a deliberate re-confirmation step.
  async function editSentItem(item, newQty) {
    const adminPin = await promptAdminPin(
      newQty === 0
        ? `Removing "${item.name}" from an order already sent to the kitchen needs admin approval.`
        : `Changing "${item.name}" on an order already sent to the kitchen needs admin approval.`
    );
    if (adminPin === null) return;
    try {
      openOrder = await api.post(`/api/sales/${openOrder.id}/items/${item.id}/edit`, { qty: newQty, admin_pin: adminPin });
      if (eligibility[item.id] > newQty) eligibility[item.id] = newQty;
      toast(newQty === 0 ? 'Item removed' : 'Item updated', 'success');
      refreshOrderPanel();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function sendToKitchen() {
    if (newItems.length === 0) return;
    try {
      const sale = await api.post('/api/sales/orders', {
        table_id: table.id,
        items: newItems.map((l) => ({ product_id: l.product_id, qty: l.qty, notes: l.notes || null })),
      });
      // The response's newly-inserted rows (not yet sent_to_kitchen) line up
      // positionally with newItems, in the same order they were posted —
      // carry each draft line's eligibility choice over to its real
      // sale_item id before newItems (and those choices) are discarded.
      const newlyAdded = sale.items.filter((i) => !i.voided && !i.sent_to_kitchen);
      newlyAdded.forEach((item, idx) => {
        // Carry the draft's value as-is, including undefined ("fully
        // eligible, tracks qty") — don't collapse it to 0.
        if (newItems[idx]) eligibility[item.id] = newItems[idx].sc_pwd_eligible_qty;
      });
      newItems = [];
      const result = await api.post(`/api/sales/${sale.id}/send-to-kitchen`);
      openOrder = result.sale;
      if (result.printed) toast('Sent to kitchen printer', 'success');
      else if (result.printError) toast(`Kitchen printer error: ${result.printError}`, 'error');
      else toast('Order sent — no kitchen printer configured, showing ticket', 'success');
      refreshOrderPanel();
      if (!result.printed) openKitchenTicketPreview(result.ticketText);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function billOut() {
    if (newItems.length > 0) { toast('Send this round to the kitchen before billing.', 'error'); return; }
    if (!openOrder || openOrder.items.filter((i) => !i.voided).length === 0) { toast('Nothing to bill yet.', 'error'); return; }
    const totals = billTotals();
    openPaymentModal(totals, async (payments, backdrop) => {
      try {
        // undefined here means "fully eligible" (see computeBillLine) —
        // resolve it to a concrete number since the server has no concept of
        // "tracks qty", only an explicit eligible count.
        const itemsPayload = openOrder.items.filter((i) => !i.voided).map((i) => ({ sale_item_id: i.id, sc_pwd_eligible_qty: eligibility[i.id] ?? i.qty }));
        const billed = await api.post(`/api/sales/${openOrder.id}/bill`, {
          payments,
          discount_type: orderDiscount.type,
          discount_id_number: orderDiscount.idNumber,
          discount_holder_name: orderDiscount.holderName,
          items: itemsPayload,
          customer_id: orderCustomer ? orderCustomer.id : null,
        });
        document.body.removeChild(backdrop);
        toast(`${table.name} billed — ${billed.sale_number}`, 'success');
        await openReceiptModal(billed.id);
        renderTablesView(container);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  // Local to this table's order — deliberately not window.APP_STATE.customer,
  // which belongs to the Register's cart and would bleed across screens.
  function openTableCustomerPicker(onSelect) {
    let results = [];
    const backdrop = el('div', { class: 'modal-backdrop' });
    const searchInput = el('input', { type: 'text', placeholder: 'Search customer by name or phone…' });
    const listEl = el('div', { style: 'margin-top:10px;max-height:240px;overflow-y:auto;' });

    async function search() {
      results = searchInput.value ? await api.get(`/api/customers?q=${encodeURIComponent(searchInput.value)}`) : await api.get('/api/customers');
      listEl.innerHTML = '';
      results.forEach((c) => {
        listEl.appendChild(el('button', { class: 'staff-btn', style: 'width:100%;margin-bottom:6px;', onclick: () => {
          document.body.removeChild(backdrop);
          onSelect(c);
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
        el('button', { class: 'btn ghost', onclick: () => { document.body.removeChild(backdrop); onSelect(null); } }, 'No customer'),
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
      ]),
    ]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    searchInput.focus();
  }

  function openTableScPwdModal() {
    let type = orderDiscount.type !== 'none' ? orderDiscount.type : 'senior';
    const backdrop = el('div', { class: 'modal-backdrop' });
    const idInput = el('input', { type: 'text', value: orderDiscount.idNumber || '', placeholder: 'e.g. OSCA/PWD ID number' });
    const nameInput = el('input', { type: 'text', value: orderDiscount.holderName || '', placeholder: 'Full name on the ID' });
    const takeoutInput = el('input', { type: 'checkbox' });
    takeoutInput.checked = Boolean(orderDiscount.isTakeout);
    const errorEl = el('div', { class: 'login-error' }, '');

    function renderModal() {
      backdrop.innerHTML = '';
      const modal = el('div', { class: 'modal' }, [
        el('h3', {}, 'Senior Citizen / PWD Discount'),
        el('p', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:-6px;' }, '20% discount + VAT exemption per RA 9994 / RA 10754. Check off exactly which items the cardholder is actually consuming — uncheck anything a companion is eating instead.'),
        el('div', { class: 'tender-methods', style: 'grid-template-columns:repeat(2,1fr);' }, [
          el('button', { class: type === 'senior' ? 'active' : '', onclick: () => { type = 'senior'; renderModal(); } }, 'Senior Citizen'),
          el('button', { class: type === 'pwd' ? 'active' : '', onclick: () => { type = 'pwd'; renderModal(); } }, 'PWD'),
        ]),
        el('div', { class: 'field', style: 'margin-top:10px;' }, [el('label', {}, `${type === 'senior' ? 'OSCA' : 'PWD'} ID Number`), idInput]),
        el('div', { class: 'field' }, [el('label', {}, 'Cardholder Name'), nameInput]),
        el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;margin-top:4px;' }, [
          takeoutInput,
          '🥡 Takeout — we can\'t know what the cardholder eats, so only the single most expensive item qualifies',
        ]),
        errorEl,
        el('div', { class: 'modal-actions' }, [
          orderDiscount.type !== 'none' ? el('button', { class: 'btn ghost', onclick: () => {
            orderDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false };
            document.body.removeChild(backdrop);
            refreshOrderPanel();
          } }, 'Remove Discount') : null,
          el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
          el('button', { class: 'btn primary', onclick: () => {
            if (!idInput.value.trim() || !nameInput.value.trim()) { errorEl.textContent = 'ID number and name are required'; return; }
            const isTakeout = takeoutInput.checked;
            const wasTakeout = orderDiscount.isTakeout;
            orderDiscount = { type, idNumber: idInput.value.trim(), holderName: nameInput.value.trim(), isTakeout };
            if (isTakeout) selectHighestPriceEligible();
            // Only reverses takeout's restrictive all-zeros defaults when
            // takeout is actually being turned off — reopening the modal to
            // fix the ID number/name (takeout unchecked both before and
            // after) must not wipe any per-item eligibility staff already
            // set by hand.
            else if (wasTakeout) clearEligibilityOverrides();
            document.body.removeChild(backdrop);
            refreshOrderPanel();
          } }, 'Apply'),
        ].filter(Boolean)),
      ]);
      backdrop.appendChild(modal);
    }
    renderModal();
    document.body.appendChild(backdrop);
  }

  refreshOrderPanel();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, table.name),
    el('button', { class: 'btn ghost', onclick: () => renderTablesView(container) }, '← Tables'),
  ]);
  const posLeft = el('div', { class: 'pos-left' }, [
    el('div', { class: 'scan-bar' }, [scanInput]),
    categoryTabs,
    productGrid,
  ]);

  container.appendChild(header);
  container.appendChild(el('div', { class: 'pos-layout', style: 'height:calc(100vh - 90px);' }, [posLeft, orderPanelRef]));
  scanInput.focus();
}

function openKitchenTicketPreview(text) {
  const backdrop = el('div', { class: 'modal-backdrop kitchen-ticket-modal' });
  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Kitchen Ticket'),
    el('div', { class: 'receipt-preview' }, text),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print (browser)'),
      el('button', { class: 'btn primary', onclick: () => document.body.removeChild(backdrop) }, 'Done'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
