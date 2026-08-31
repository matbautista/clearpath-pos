let posProducts = [];
let posCategories = [];
let posChannels = [];

// Register flow mirrors Tables: staff first pick which customer slot the
// order belongs to (there's no physical table to distinguish one walk-in
// order in progress from another), then within that slot items go out to
// the kitchen (and stock is deducted) as an open order, and only once
// something's actually been sent can the order be charged — there's no more
// "ring it up and pay in one step." The Register additionally supports
// FoodPanda/GrabFood order channels, which Tables doesn't need.
async function renderPosView(container) {
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
            'You need to open a cash drawer shift before starting or charging any order.'),
          el('button', { class: 'btn primary', onclick: () => navigate('shift') }, 'Open Shift'),
        ]),
      ]));
      return;
    }
  }

  const slots = await api.get('/api/registers');

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Register'),
    ['admin', 'manager'].includes(user.role)
      ? el('button', { class: 'btn ghost', onclick: () => openManageRegistersModal(() => renderPosView(container)) }, 'Manage Customers')
      : null,
  ].filter(Boolean));

  const grid = el('div', { class: 'product-grid' });
  if (slots.length === 0) {
    grid.appendChild(el('div', { class: 'empty-state' }, 'No customer slots yet. Use "Manage Customers" to add some.'));
  }
  slots.forEach((t) => {
    const occupied = Boolean(t.open_sale);
    // shift_id is null either because the order's original shift closed
    // while it was still open (a real hand-off), or because it was opened
    // by a waiter, who never has a shift at all. Either way there's no
    // shift claiming it yet, so the label stays neutral rather than
    // assuming a hand-off happened.
    const noShift = occupied && t.open_sale.shift_id === null;
    grid.appendChild(el('button', {
      class: 'product-tile',
      style: `background:${occupied ? '#e0473f' : '#1ea672'};min-height:100px;`,
      onclick: () => renderRegisterOrderScreen(container, t),
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

function openManageRegistersModal(onDone) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const nameInput = el('input', { type: 'text', placeholder: 'New customer slot name (e.g. Customer 11)' });
  const listEl = el('div', { style: 'margin:10px 0;max-height:260px;overflow-y:auto;' });

  async function refresh() {
    const slots = await api.get('/api/registers');
    listEl.innerHTML = '';
    slots.forEach((t) => {
      listEl.appendChild(el('div', { class: 'totals-row' }, [
        el('span', {}, t.name + (t.open_sale ? ' (occupied)' : '')),
        el('button', { class: 'btn small danger', onclick: async () => {
          try { await api.del(`/api/registers/${t.id}`); refresh(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Remove'),
      ]));
    });
  }
  refresh();

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Manage Customer Slots'),
    listEl,
    el('div', { class: 'field' }, [nameInput]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => { document.body.removeChild(backdrop); onDone(); } }, 'Close'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!nameInput.value.trim()) return;
        try { await api.post('/api/registers', { name: nameInput.value.trim() }); nameInput.value = ''; refresh(); }
        catch (e) { toast(e.message, 'error'); }
      } }, 'Add'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

async function renderRegisterOrderScreen(container, slot) {
  container.innerHTML = '';
  // cashier can build the order and charge it; waiter can build it but never
  // charge; admin/manager are read-only ("view only, not able to transact").
  const capability = orderCapability(window.APP_STATE.user.role);
  const canBuild = capability !== 'view';
  const canCharge = capability === 'full';
  let openOrder = await api.get(`/api/sales/register-slot/${slot.id}/open`);

  try {
    [posCategories, posChannels] = await Promise.all([
      api.get('/api/categories'),
      api.get('/api/channels?active=true'),
    ]);
  } catch (e) {
    toast(e.message, 'error');
  }

  const walkInChannel = posChannels.find((c) => c.name === 'Walk-in') || null;
  let channel = (openOrder && openOrder.channel_id && (!walkInChannel || openOrder.channel_id !== walkInChannel.id))
    ? posChannels.find((c) => c.id === openOrder.channel_id) || null
    : null;
  let customer = openOrder && openOrder.customer_id ? { id: openOrder.customer_id, name: openOrder.customer_name } : null;
  let orderDiscount = { type: 'none', idNumber: '', holderName: '', isTakeout: false };
  let newItems = []; // this round, not sent yet: { product_id, name, price, tax_rate, qty, notes }
  let activeCategory = null;
  const eligibility = {}; // sale_item_id -> eligible qty (0..item.qty), used only once charging starts

  async function loadProducts() {
    try {
      posProducts = await api.get(`/api/products?active=true${channel ? `&channel_id=${channel.id}` : ''}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  await loadProducts();

  const scanInput = el('input', {
    type: 'text',
    placeholder: canBuild ? 'Scan barcode or type SKU, then press Enter…' : 'View only',
    autofocus: canBuild ? 'true' : null,
    disabled: canBuild ? null : 'true',
  });
  scanInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && scanInput.value.trim()) {
      await handleBarcode(scanInput.value.trim());
      scanInput.value = '';
    }
  });

  const categoryTabs = el('div', { class: 'category-tabs' }, [
    el('button', { class: activeCategory === null ? 'active' : '', onclick: () => { activeCategory = null; refreshGrid(); } }, 'All'),
    ...posCategories.map((c) => el('button', {
      class: activeCategory === c.id ? 'active' : '',
      onclick: () => { activeCategory = c.id; refreshGrid(); },
    }, c.name)),
  ]);

  const grid = el('div', { class: 'product-grid' });
  function refreshGrid() {
    grid.innerHTML = '';
    const items = posProducts.filter((p) => activeCategory === null || p.category_id === activeCategory);
    if (items.length === 0) {
      grid.appendChild(el('div', { class: 'empty-state' }, 'No products in this category yet.'));
      return;
    }
    for (const p of items) {
      const outOfStock = p.track_stock && p.stock_qty <= 0;
      const channelBlocked = p.channel_available === 0;
      const disabled = outOfStock || channelBlocked || !canBuild;
      grid.appendChild(el('button', {
        class: `product-tile ${disabled ? 'out' : ''}`,
        style: productTileStyle(p),
        disabled: disabled ? 'true' : null,
        onclick: canBuild ? () => addNewItem(p) : null,
      }, [
        el('div', { class: 'name' }, p.name),
        el('div', {}, [
          el('div', { class: 'price' }, money(p.price)),
          el('div', { class: 'stock' }, channelBlocked
            ? `Not on ${channel ? channel.name : 'channel'}`
            : (p.track_stock ? `${p.stock_qty} in stock` : '')),
        ]),
      ]));
    }
  }
  refreshGrid();

  async function handleBarcode(code) {
    const local = posProducts.find((p) => p.barcode === code || p.sku === code);
    if (local) { addNewItem(local); return; }
    try {
      const p = await api.get(`/api/products/barcode/${encodeURIComponent(code)}${channel ? `?channel_id=${channel.id}` : ''}`);
      addNewItem(p);
    } catch (e) {
      toast(`No product found for "${code}"`, 'error');
    }
  }

  function addNewItem(product) {
    if (product.channel_available === 0) {
      toast(`${product.name} is not available on ${channel ? channel.name : 'this channel'}`, 'error');
      return;
    }
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

  // Reloads the product list priced for whatever channel is currently
  // selected (FoodPanda/GrabFood menu prices are marked up to absorb that
  // platform's commission), and re-prices any not-yet-sent draft lines so
  // they always reflect the active channel's price. Already sent-to-kitchen
  // items keep whatever price they were sent at — switching channels
  // mid-order doesn't retroactively reprice committed lines.
  async function refreshProductsForChannel() {
    await loadProducts();
    const blockedNames = [];
    for (const line of newItems) {
      const p = posProducts.find((pp) => pp.id === line.product_id);
      if (p) {
        line.price = p.price;
        if (p.channel_available === 0) blockedNames.push(p.name);
      }
    }
    if (blockedNames.length) {
      toast(`Not available on ${channel ? channel.name : 'this channel'}: ${blockedNames.join(', ')} — remove before sending`, 'error');
    }
    refreshGrid();
    refreshOrderPanel();
  }

  // Shared with tables.js — see public/js/lib/orderCart.js.
  const cart = createOrderCartLogic({
    getOpenOrder: () => openOrder,
    getNewItems: () => newItems,
    getOrderDiscount: () => orderDiscount,
    eligibility,
  });
  const { computeBillLine, computeLineTotals, billTotals, selectHighestPriceEligible, clearEligibilityOverrides } = cart;

  const orderPanelRef = el('div', { class: 'pos-right' });

  function refreshOrderPanel() {
    orderPanelRef.innerHTML = '';
    const discountLabel = orderDiscount.type === 'senior' ? 'Senior' : orderDiscount.type === 'pwd' ? 'PWD' : null;

    const panelHeader = el('div', { class: 'cart-header' }, [
      el('h3', {}, slot.name),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;' }, [
        el('button', {
          class: `btn small ${discountLabel ? '' : 'ghost'}`,
          style: discountLabel ? 'background:#1ea672;border-color:#1ea672;color:#fff;' : '',
          disabled: canBuild ? null : 'true',
          onclick: canBuild ? () => openScPwdModal() : null,
        }, discountLabel ? `🎫 ${discountLabel}${orderDiscount.isTakeout ? ' 🥡' : ''}` : '🎫 SC/PWD'),
        el('button', {
          class: 'btn ghost small',
          disabled: canBuild ? null : 'true',
          onclick: canBuild ? () => openCustomerPicker((c) => { customer = c; refreshOrderPanel(); }) : null,
        }, customer ? customer.name : '+ Customer'),
        el('button', {
          class: 'btn ghost small',
          disabled: canBuild ? null : 'true',
          onclick: canBuild ? () => openChannelPicker(refreshProductsForChannel) : null,
        }, `🛵 ${channel ? channel.name : 'Walk-in'}`),
      ]),
    ]);

    const sentItems = openOrder ? openOrder.items.filter((i) => !i.voided) : [];
    const itemsEl = el('div', { class: 'cart-items' });
    if (sentItems.length === 0 && newItems.length === 0) {
      itemsEl.appendChild(el('div', { class: 'cart-empty' }, 'No items yet. Tap a product or scan a barcode.'));
    }
    if (sentItems.length) {
      itemsEl.appendChild(el('div', { style: 'font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin:6px 4px 2px;' }, 'Sent to kitchen'));
      sentItems.forEach((line) => {
        // Any dish, any quantity can carry the discount — checkboxes are
        // independent. A qty-1 line is a plain checkbox; a qty>1 line gets a
        // number input so staff can pick exactly how many units qualify.
        const eligToggle = discountLabel ? el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);white-space:nowrap;' }, [
          (() => {
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
        onclick: sendOrder,
      }, '🍳 Send to Kitchen'),
      el('button', {
        class: 'btn success', disabled: (!canCharge || sentItems.length === 0 || newItems.length > 0) ? 'true' : null,
        onclick: chargeOrder,
      }, '💳 Charge'),
    ]);

    orderPanelRef.appendChild(panelHeader);
    orderPanelRef.appendChild(itemsEl);
    orderPanelRef.appendChild(totalsEl);
    orderPanelRef.appendChild(actions);
  }

  // Shared with tables.js — see public/js/lib/orderCart.js.
  const editSentItem = createEditSentItem({
    getSale: () => openOrder,
    setSale: (s) => { openOrder = s; },
    eligibility,
    refresh: refreshOrderPanel,
  });

  async function sendOrder() {
    if (newItems.length === 0) return;
    try {
      const sale = await api.post('/api/sales/orders', {
        register_slot_id: slot.id,
        channel_id: channel ? channel.id : null,
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

  function chargeOrder() {
    if (newItems.length > 0) { toast('Send this round to the kitchen before charging.', 'error'); return; }
    if (!openOrder || openOrder.items.filter((i) => !i.voided).length === 0) { toast('Nothing to charge yet.', 'error'); return; }
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
          customer_id: customer ? customer.id : null,
        });
        document.body.removeChild(backdrop);
        toast(`Sale ${billed.sale_number} completed`, 'success');
        await openReceiptModal(billed.id);
        renderPosView(container);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  function openChannelPicker(onDone) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const listEl = el('div', { style: 'margin-top:10px;max-height:280px;overflow-y:auto;' });

    posChannels.forEach((c) => {
      listEl.appendChild(el('button', { class: 'staff-btn', style: 'width:100%;margin-bottom:6px;', onclick: () => {
        channel = c.name === 'Walk-in' ? null : c;
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

  // Shared with tables.js — see public/js/lib/orderCart.js.
  function openScPwdModal() {
    openScPwdDiscountModal({
      getOrderDiscount: () => orderDiscount,
      setOrderDiscount: (d) => { orderDiscount = d; },
      selectHighestPriceEligible,
      clearEligibilityOverrides,
      refresh: refreshOrderPanel,
    });
  }

  refreshOrderPanel();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, slot.name),
    el('button', { class: 'btn ghost', onclick: () => renderPosView(container) }, '← Register'),
  ]);
  const posLeft = el('div', { class: 'pos-left' }, [
    el('div', { class: 'scan-bar' }, [scanInput]),
    categoryTabs,
    grid,
  ]);

  container.appendChild(header);
  container.appendChild(el('div', { class: 'pos-layout', style: 'height:calc(100vh - 90px);' }, [posLeft, orderPanelRef]));
  scanInput.focus();
}

// totals: { total } at minimum. onComplete(finalPayments, backdrop) is
// called with the assembled payment list and must close the modal itself
// (via document.body.removeChild(backdrop)) once done. Shared by the
// Register and the Tables order "Charge"/"Bill Out" flow.
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
