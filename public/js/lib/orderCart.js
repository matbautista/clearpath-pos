// SC/PWD discount math and per-item eligibility bookkeeping shared by the
// Register (pos.js) and Tables (tables.js) order screens — both build an
// order the same way (send rounds to the kitchen, then charge/bill with
// SC/PWD eligibility resolved at that point), so this is the one place the
// logic lives instead of being copied between the two screens.
//
// ctx.getOpenOrder() -> current open order object, or null
// ctx.getNewItems()  -> this round's not-yet-sent draft items
// ctx.getOrderDiscount() -> { type: 'none'|'senior'|'pwd', isTakeout, ... }
// ctx.eligibility -> mutable object, sale_item_id -> eligible qty (0..item.qty)
function createOrderCartLogic(ctx) {
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
  // `item.sc_pwd_eligible_qty` — same "missing means fully eligible, tracks
  // qty" default either way.
  function eligibleQtyFor(item) {
    return item.id !== undefined ? (ctx.eligibility[item.id] ?? item.qty) : (item.sc_pwd_eligible_qty ?? item.qty);
  }

  function computeBillLine(item) {
    const scPwdActive = ctx.getOrderDiscount().type !== 'none';
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

  function sentItems() {
    const openOrder = ctx.getOpenOrder();
    return openOrder ? openOrder.items.filter((i) => !i.voided) : [];
  }

  function billTotals() {
    return computeLineTotals(sentItems());
  }

  // Every eligible-for-discount item currently on the order — sent-to-kitchen
  // lines (keyed by sale_item id in `eligibility`) plus this round's unsent
  // drafts (keyed on the line object itself).
  function allOrderLines() {
    return [...sentItems(), ...ctx.getNewItems()];
  }

  // Defaults eligibility for takeout: only ONE unit of the single
  // highest-priced (per-unit) item across the whole order — sent or not —
  // starts out marked, everything else 0, since staff can't know which item
  // the PWD/senior will actually eat. This is only a starting point, not an
  // ongoing constraint — staff can still check any other dish/quantity
  // afterward.
  function selectHighestPriceEligible() {
    for (const i of sentItems()) ctx.eligibility[i.id] = 0;
    for (const l of ctx.getNewItems()) l.sc_pwd_eligible_qty = 0;
    const lines = allOrderLines();
    if (lines.length === 0) return;
    let top = lines[0];
    for (const l of lines) if (l.price > top.price) top = l;
    const qty = Math.min(1, top.qty);
    if (top.id !== undefined) ctx.eligibility[top.id] = qty;
    else top.sc_pwd_eligible_qty = qty;
  }

  // Reverses selectHighestPriceEligible(): a missing eligibility[id] /
  // undefined sc_pwd_eligible_qty reads as "fully eligible, tracks qty"
  // everywhere it's consumed, so un-checking takeout after it was applied
  // must clear the restrictive zeros it left behind rather than leaving most
  // of the order stuck ineligible.
  function clearEligibilityOverrides() {
    for (const i of sentItems()) delete ctx.eligibility[i.id];
    for (const l of ctx.getNewItems()) l.sc_pwd_eligible_qty = undefined;
  }

  return {
    computeSubtotal, eligibleQtyFor, computeBillLine, computeLineTotals,
    billTotals, allOrderLines, selectHighestPriceEligible, clearEligibilityOverrides,
  };
}

// Edits or removes (qty 0) a line item already sent to the kitchen. Always
// requires a manager PIN to confirm, even if the current user is already
// logged in as manager — a deliberate re-confirmation step, since stock's
// already moved and the kitchen may already be cooking it. Admin cannot
// approve this — manager-only, by design.
//
// ctx.getSale()/ctx.setSale(sale) read/write the screen's local open-order
// variable; ctx.eligibility is the screen's sale_item_id -> eligible qty map;
// ctx.refresh() re-renders the order panel.
function createEditSentItem(ctx) {
  return async function editSentItem(item, newQty) {
    const approverPin = await promptApproverPin(
      newQty === 0
        ? `Removing "${item.name}" from an order already sent to the kitchen needs manager approval.`
        : `Changing "${item.name}" on an order already sent to the kitchen needs manager approval.`
    );
    if (approverPin === null) return;
    try {
      const sale = await api.post(`/api/sales/${ctx.getSale().id}/items/${item.id}/edit`, { qty: newQty, admin_pin: approverPin });
      ctx.setSale(sale);
      if (ctx.eligibility[item.id] > newQty) ctx.eligibility[item.id] = newQty;
      toast(newQty === 0 ? 'Item removed' : 'Item updated', 'success');
      ctx.refresh();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

// Local to whichever order is currently open — deliberately not
// window.APP_STATE.customer, which would bleed across screens/orders.
function openCustomerPicker(onSelect) {
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

// ctx.getOrderDiscount()/ctx.setOrderDiscount(discount), ctx.selectHighestPriceEligible(),
// ctx.clearEligibilityOverrides(), ctx.refresh() re-renders the order panel.
function openScPwdDiscountModal(ctx) {
  const current = ctx.getOrderDiscount();
  let type = current.type !== 'none' ? current.type : 'senior';
  const backdrop = el('div', { class: 'modal-backdrop' });
  const idInput = el('input', { type: 'text', value: current.idNumber || '', placeholder: 'e.g. OSCA/PWD ID number' });
  const nameInput = el('input', { type: 'text', value: current.holderName || '', placeholder: 'Full name on the ID' });
  const takeoutInput = el('input', { type: 'checkbox' });
  takeoutInput.checked = Boolean(current.isTakeout);
  const errorEl = el('div', { class: 'login-error' }, '');

  function renderModal() {
    backdrop.innerHTML = '';
    const orderDiscount = ctx.getOrderDiscount();
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
          ctx.setOrderDiscount({ type: 'none', idNumber: '', holderName: '', isTakeout: false });
          document.body.removeChild(backdrop);
          ctx.refresh();
        } }, 'Remove Discount') : null,
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => {
          if (!idInput.value.trim() || !nameInput.value.trim()) { errorEl.textContent = 'ID number and name are required'; return; }
          const isTakeout = takeoutInput.checked;
          const wasTakeout = orderDiscount.isTakeout;
          ctx.setOrderDiscount({ type, idNumber: idInput.value.trim(), holderName: nameInput.value.trim(), isTakeout });
          if (isTakeout) ctx.selectHighestPriceEligible();
          // Only reverses takeout's restrictive all-zeros defaults when
          // takeout is actually being turned off — reopening the modal to
          // fix the ID number/name (takeout unchecked both before and after)
          // must not wipe any per-item eligibility staff already set by hand.
          else if (wasTakeout) ctx.clearEligibilityOverrides();
          document.body.removeChild(backdrop);
          ctx.refresh();
        } }, 'Apply'),
      ].filter(Boolean)),
    ]);
    backdrop.appendChild(modal);
  }
  renderModal();
  document.body.appendChild(backdrop);
}
