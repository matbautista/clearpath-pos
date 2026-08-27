const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { dateRange } = require('../lib/dateRange');
const {
  buildEscPosReceipt, buildPlainTextReceipt, sendToNetworkPrinter,
  buildKitchenTicketEscPos, buildKitchenTicketText,
} = require('../lib/receipt');
const mailer = require('../lib/mailer');

const router = express.Router();
router.use(requireAuth);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function nextSaleNumber() {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `S-${ymd}-`;
  const row = db.prepare(
    `SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`${prefix}%`);
  let seq = 1;
  if (row) {
    const parts = row.sale_number.split('-');
    seq = Number(parts[parts.length - 1]) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function resolveChannelId(channelId) {
  if (channelId) return channelId;
  const row = db.prepare("SELECT id FROM channels WHERE name = 'Walk-in'").get();
  return row ? row.id : null;
}

// A channel's price override (e.g. FoodPanda/GrabFood menu prices, marked up
// to absorb the platform's commission) always wins over whatever price the
// client sent — same reasoning as trusting the DB for tax_rate: the price a
// channel charges isn't something a cashier should be able to override.
function channelPriceOverride(productId, channelId) {
  if (!productId || !channelId) return null;
  const row = db.prepare('SELECT price FROM product_channel_prices WHERE product_id = ? AND channel_id = ?').get(productId, channelId);
  return row ? row.price : null;
}

// Some menu items aren't offered on a given delivery platform at all — a
// missing row means available (the common case), so only an explicit
// available = 0 row blocks the sale.
function channelAvailable(productId, channelId) {
  if (!productId || !channelId) return true;
  const row = db.prepare('SELECT available FROM product_channel_prices WHERE product_id = ? AND channel_id = ?').get(productId, channelId);
  return row ? Boolean(row.available) : true;
}

function getOpenShift(userId) {
  return db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(userId);
}

// Every route that rings up or bills a sale requires the acting cashier or
// manager to have their own open cash drawer shift first — sales aren't
// attributable to a drawer otherwise, and end-of-day reconciliation would
// have no home for them. Only admins are exempt; if one happens to have a
// shift open anyway, the sale still attributes to it.
function requireShiftForRole(role) {
  return role !== 'admin';
}
const NO_SHIFT_ERROR = 'Open a cash drawer shift before ringing up sales — go to Cash Drawer to start one.';

// Editing a line item that's already been sent to the kitchen needs an
// admin PIN typed in to confirm — every time, even if the person doing it is
// already logged in as an admin. Stock's already moved and the kitchen may
// already be cooking it, so this is a deliberate re-confirmation step, not
// just a role check.
function ensureAdminApproved(req, pin) {
  const admins = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1").all();
  const admin = pin ? admins.find((u) => bcrypt.compareSync(String(pin), u.pin_hash)) : null;
  if (!admin) {
    const err = new Error('Admin approval required to edit an order already sent to the kitchen');
    err.status = 403;
    throw err;
  }
  return { name: admin.name };
}

// RA 9994 (Senior Citizens) / RA 10754 (PWD): 20% discount on the
// VAT-exclusive price, with the sale becoming VAT-exempt, for eligible lines.
function computeSaleLine({ price, qty, taxRate, manualDiscount, scPwdEligible }) {
  const grossAfterManual = price * qty - manualDiscount;
  if (scPwdEligible) {
    const vatExclusive = grossAfterManual / (1 + taxRate);
    const vatExemptAmount = grossAfterManual - vatExclusive;
    const scPwdDiscount = vatExclusive * 0.2;
    return {
      discount: manualDiscount + scPwdDiscount,
      taxAmount: 0,
      vatExemptAmount,
      lineTotal: vatExclusive - scPwdDiscount,
    };
  }
  const taxAmount = grossAfterManual * taxRate;
  return { discount: manualDiscount, taxAmount, vatExemptAmount: 0, lineTotal: grossAfterManual + taxAmount };
}

// Recomputes a sale's aggregate totals from its current (non-voided) line
// items. Used after appending items to an open order and after re-pricing
// items at billing time.
function recomputeSaleTotals(saleId) {
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND voided = 0').all(saleId);
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const discountTotal = items.reduce((s, i) => s + i.discount, 0);
  const taxTotal = items.reduce((s, i) => s + i.tax_amount, 0);
  const vatExemptTotal = items.reduce((s, i) => s + i.vat_exempt_amount, 0);
  const total = items.reduce((s, i) => s + i.line_total, 0);
  db.prepare(`
    UPDATE sales SET subtotal = ?, discount_total = ?, tax_total = ?, vat_exempt_total = ?, total = ? WHERE id = ?
  `).run(subtotal, discountTotal, taxTotal, vatExemptTotal, total, saleId);
}

function recordPayments(saleId, payments) {
  // Change is whatever a cash payment's tendered amount exceeds the amount
  // actually applied to the sale (amount is net of change; tendered is what
  // the customer physically handed over).
  let changeGiven = 0;
  const insertPayment = db.prepare(`
    INSERT INTO payments (sale_id, method, amount, tendered, change_given, reference)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const p of payments) {
    const amount = Number(p.amount);
    const tendered = p.tendered !== undefined ? Number(p.tendered) : amount;
    const change = p.method === 'cash' ? Math.max(0, tendered - amount) : 0;
    changeGiven += change;
    insertPayment.run(saleId, p.method, amount, tendered, change, p.reference || null);
  }
  return changeGiven;
}

// ---- Checkout (immediate, no table involved) ----
router.post('/checkout', (req, res) => {
  const {
    items, payments, customer_id, note, channel_id,
    discount_type, discount_id_number, discount_holder_name,
  } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  if (!Array.isArray(payments) || payments.length === 0) {
    return res.status(400).json({ error: 'At least one payment is required' });
  }
  const scPwdType = ['senior', 'pwd'].includes(discount_type) ? discount_type : 'none';
  if (scPwdType !== 'none' && (!discount_id_number || !discount_holder_name)) {
    return res.status(400).json({ error: 'Senior Citizen / PWD ID number and holder name are required for this discount' });
  }

  const shift = getOpenShift(req.session.userId);
  if (!shift && requireShiftForRole(req.session.role)) return res.status(400).json({ error: NO_SHIFT_ERROR });

  const resolvedChannelId = resolveChannelId(channel_id);

  const tx = db.transaction(() => {
    const lineData = [];
    for (const item of items) {
      const product = item.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) : null;
      if (product && !channelAvailable(product.id, resolvedChannelId)) {
        throw new Error(`${product.name} is not available on this order channel`);
      }
      const qty = Number(item.qty) || 1;
      const override = channelPriceOverride(product?.id, resolvedChannelId);
      const price = Number(override ?? item.price ?? product?.price ?? 0);
      const taxRate = Number(item.tax_rate ?? product?.tax_rate ?? 0);
      const manualDiscount = Number(item.discount) || 0;
      const name = item.name || product?.name || 'Item';
      const product_id = product ? product.id : null;

      // A line can be partially SC/PWD-eligible (e.g. 2 of 3 units consumed
      // by the cardholder, or takeout's single discounted unit within a
      // bigger quantity) — split it into two sale_item rows, one per
      // eligible/regular sub-quantity, each priced through the normal
      // formula. manualDiscount isn't currently settable from any UI (always
      // 0 in practice), so it's applied to the regular portion only.
      const eligibleQty = scPwdType !== 'none' ? Math.max(0, Math.min(Number(item.sc_pwd_eligible_qty) || 0, qty)) : 0;
      const regularQty = qty - eligibleQty;

      if (eligibleQty > 0) {
        const elig = computeSaleLine({ price, qty: eligibleQty, taxRate, manualDiscount: 0, scPwdEligible: true });
        lineData.push({
          product_id, name, price, qty: eligibleQty, discount: elig.discount, tax_rate: taxRate,
          tax_amount: elig.taxAmount, vat_exempt_amount: elig.vatExemptAmount, sc_pwd_eligible: 1,
          notes: item.notes || null, line_total: elig.lineTotal,
        });
      }
      if (regularQty > 0) {
        const reg = computeSaleLine({ price, qty: regularQty, taxRate, manualDiscount, scPwdEligible: false });
        lineData.push({
          product_id, name, price, qty: regularQty, discount: reg.discount, tax_rate: taxRate,
          tax_amount: reg.taxAmount, vat_exempt_amount: reg.vatExemptAmount, sc_pwd_eligible: 0,
          notes: item.notes || null, line_total: reg.lineTotal,
        });
      }
    }

    const total = lineData.reduce((s, l) => s + l.line_total, 0);
    const paidTotal = payments.reduce((s, p) => s + Number(p.amount), 0);
    if (paidTotal + 0.005 < total) {
      throw new Error(`Payment total (${paidTotal.toFixed(2)}) is less than sale total (${total.toFixed(2)})`);
    }

    const saleNumber = nextSaleNumber();
    const saleInfo = db.prepare(`
      INSERT INTO sales (sale_number, user_id, customer_id, shift_id, channel_id, order_status, billed_at, discount_type, discount_id_number, discount_holder_name, note)
      VALUES (?, ?, ?, ?, ?, 'billed', datetime('now'), ?, ?, ?, ?)
    `).run(
      saleNumber, req.session.userId, customer_id || null, shift ? shift.id : null, resolvedChannelId,
      scPwdType, scPwdType !== 'none' ? discount_id_number : null, scPwdType !== 'none' ? discount_holder_name : null,
      note || null
    );

    const saleId = saleInfo.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, name, price, qty, discount, tax_rate, tax_amount, vat_exempt_amount, sc_pwd_eligible, notes, sent_to_kitchen, line_total)
      VALUES (@sale_id, @product_id, @name, @price, @qty, @discount, @tax_rate, @tax_amount, @vat_exempt_amount, @sc_pwd_eligible, @notes, 1, @line_total)
    `);
    const decStock = db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND track_stock = 1');
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
      VALUES (?, ?, 'sale', ?, ?)
    `);

    for (const l of lineData) {
      insertItem.run({ ...l, sale_id: saleId });
      if (l.product_id) {
        decStock.run(l.qty, l.product_id);
        insertMovement.run(l.product_id, -l.qty, saleNumber, req.session.userId);
      }
    }

    recomputeSaleTotals(saleId);
    const changeGiven = recordPayments(saleId, payments);

    if (customer_id) {
      db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(Math.floor(total / 100), customer_id);
    }

    return { saleId, saleNumber, changeGiven };
  });

  try {
    const result = tx();
    res.json(getSaleDetail(result.saleId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function getSaleDetail(id) {
  const sale = db.prepare(`
    SELECT s.*, u.name as cashier_name, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
      t.name as table_name, ch.name as channel_name, ch.commission_rate as channel_commission_rate
    FROM sales s
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN tables t ON t.id = s.table_id
    LEFT JOIN channels ch ON ch.id = s.channel_id
    WHERE s.id = ?
  `).get(id);
  if (!sale) return null;
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  sale.payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(id);
  return sale;
}

// ---- Table orders (restaurant flow: order now, bill later) ----

// Sends a round of items to a table's tab — creates the open order if this
// is the table's first round, otherwise appends to it. Items are priced
// without any SC/PWD discount yet (that's only known at billing time) and
// stock is deducted immediately, since the kitchen prepares on order, not
// on payment.
router.post('/orders', (req, res) => {
  const { table_id, items, note } = req.body;
  if (!table_id) return res.status(400).json({ error: 'table_id is required' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND active = 1').get(table_id);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const shift = getOpenShift(req.session.userId);
  if (!shift && requireShiftForRole(req.session.role)) return res.status(400).json({ error: NO_SHIFT_ERROR });

  const tx = db.transaction(() => {
    let sale = db.prepare(`SELECT * FROM sales WHERE table_id = ? AND order_status = 'open'`).get(table_id);
    let saleId;
    if (!sale) {
      const saleNumber = nextSaleNumber();
      const info = db.prepare(`
        INSERT INTO sales (sale_number, user_id, table_id, shift_id, channel_id, order_status, note)
        VALUES (?, ?, ?, ?, ?, 'open', ?)
      `).run(saleNumber, req.session.userId, table_id, shift ? shift.id : null, resolveChannelId(null), note || null);
      saleId = info.lastInsertRowid;
    } else {
      saleId = sale.id;
    }

    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, name, price, qty, tax_rate, tax_amount, notes, line_total)
      VALUES (@sale_id, @product_id, @name, @price, @qty, @tax_rate, @tax_amount, @notes, @line_total)
    `);
    const decStock = db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND track_stock = 1');
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
      VALUES (?, ?, 'sale', ?, ?)
    `);

    for (const item of items) {
      const product = item.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) : null;
      const qty = Number(item.qty) || 1;
      if (product && product.track_stock && product.stock_qty < qty) {
        throw new Error(`Only ${product.stock_qty} of ${product.name} left in stock`);
      }
      const price = Number(item.price ?? product?.price ?? 0);
      const taxRate = Number(item.tax_rate ?? product?.tax_rate ?? 0);
      const taxAmount = price * qty * taxRate;
      insertItem.run({
        sale_id: saleId, product_id: product ? product.id : null,
        name: item.name || product?.name || 'Item', price, qty,
        tax_rate: taxRate, tax_amount: taxAmount, notes: item.notes || null,
        line_total: price * qty + taxAmount,
      });
      if (product) {
        decStock.run(qty, product.id);
        insertMovement.run(product.id, -qty, `${table.name} / ${sale ? sale.sale_number : ''}`, req.session.userId);
      }
    }

    recomputeSaleTotals(saleId);
    return saleId;
  });

  try {
    const saleId = tx();
    res.json(getSaleDetail(saleId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Marks any not-yet-sent items on an open order as sent, and prints/returns
// a no-price kitchen ticket for just that new round.
router.post('/:id/send-to-kitchen', async (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Order not found' });
  if (sale.order_status !== 'open') return res.status(400).json({ error: 'This order has already been billed' });

  const newItems = sale.items.filter((i) => !i.voided && !i.sent_to_kitchen);
  if (newItems.length === 0) return res.status(400).json({ error: 'Nothing new to send to the kitchen' });

  db.prepare('UPDATE sale_items SET sent_to_kitchen = 1 WHERE sale_id = ? AND sent_to_kitchen = 0').run(sale.id);

  const ticket = {
    tableName: sale.table_name || 'Order',
    saleNumber: sale.sale_number,
    createdAt: new Date().toLocaleString(),
    items: newItems.map((i) => ({ name: i.name, qty: i.qty, notes: i.notes })),
  };

  const enabled = getSetting('kitchen_printer_enabled', 'false') === 'true';
  const target = getSetting('kitchen_printer_target', '');
  let printed = false;
  let printError = null;
  if (enabled && target) {
    try {
      await sendToNetworkPrinter(target, buildKitchenTicketEscPos(ticket));
      printed = true;
    } catch (e) {
      printError = e.message;
    }
  }
  res.json({ ok: true, printed, printError, ticket, ticketText: buildKitchenTicketText(ticket), sale: getSaleDetail(sale.id) });
});

// Edits a single line item on an OPEN order — including items already sent
// to the kitchen. Admins can do this directly; anyone else must pass a valid
// admin PIN in admin_pin. Use qty: 0 to remove/void the item entirely.
router.post('/:id/items/:itemId/edit', (req, res) => {
  const { qty, admin_pin } = req.body;
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Order not found' });
  if (sale.order_status !== 'open') {
    return res.status(400).json({ error: 'This order has already been billed — void or refund it instead.' });
  }
  const item = sale.items.find((i) => i.id === Number(req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Item not found on this order' });
  if (item.voided) return res.status(400).json({ error: 'Item is already voided' });

  const newQty = Number(qty);
  if (!Number.isFinite(newQty) || newQty < 0) {
    return res.status(400).json({ error: 'qty must be 0 or greater' });
  }

  let approver;
  try {
    approver = ensureAdminApproved(req, admin_pin);
  } catch (e) {
    return res.status(e.status || 403).json({ error: e.message });
  }

  const tx = db.transaction(() => {
    const product = item.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) : null;
    const deltaQty = newQty - item.qty; // positive = consuming more stock, negative = giving stock back
    if (deltaQty > 0 && product && product.track_stock && product.stock_qty < deltaQty) {
      throw new Error(`Only ${product.stock_qty} of ${product.name} left in stock`);
    }
    if (product && product.track_stock && deltaQty !== 0) {
      db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(deltaQty, product.id);
      const reference = `${sale.sale_number} (edited by ${req.session.name}, approved by ${approver.name})`;
      db.prepare(`
        INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(product.id, -deltaQty, deltaQty > 0 ? 'sale' : 'void', reference, req.session.userId);
    }

    if (newQty === 0) {
      db.prepare('UPDATE sale_items SET voided = 1 WHERE id = ?').run(item.id);
    } else {
      const taxAmount = item.price * newQty * item.tax_rate;
      const lineTotal = item.price * newQty + taxAmount;
      db.prepare('UPDATE sale_items SET qty = ?, tax_amount = ?, line_total = ? WHERE id = ?')
        .run(newQty, taxAmount, lineTotal, item.id);
    }
    recomputeSaleTotals(sale.id);
  });

  try {
    tx();
    res.json(getSaleDetail(sale.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Finalizes payment for an open table order: re-prices every line for the
// SC/PWD discount now that eligibility is known, records payment, and
// closes out the order (which frees up the table).
router.post('/:id/bill', (req, res) => {
  const { payments, discount_type, discount_id_number, discount_holder_name, items, customer_id } = req.body;
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Order not found' });
  if (sale.order_status !== 'open') return res.status(400).json({ error: 'This order has already been billed' });
  if (!Array.isArray(payments) || payments.length === 0) {
    return res.status(400).json({ error: 'At least one payment is required' });
  }
  const scPwdType = ['senior', 'pwd'].includes(discount_type) ? discount_type : 'none';
  if (scPwdType !== 'none' && (!discount_id_number || !discount_holder_name)) {
    return res.status(400).json({ error: 'Senior Citizen / PWD ID number and holder name are required for this discount' });
  }
  const eligibilityByItem = {};
  for (const i of (items || [])) eligibilityByItem[i.sale_item_id] = Number(i.sc_pwd_eligible_qty) || 0;

  const shift = getOpenShift(req.session.userId);
  if (!shift && requireShiftForRole(req.session.role)) return res.status(400).json({ error: NO_SHIFT_ERROR });

  const tx = db.transaction(() => {
    const updateItem = db.prepare(`
      UPDATE sale_items SET qty = ?, discount = ?, tax_amount = ?, vat_exempt_amount = ?, sc_pwd_eligible = ?, line_total = ? WHERE id = ?
    `);
    const insertSplitItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, name, price, qty, discount, tax_rate, tax_amount, vat_exempt_amount, sc_pwd_eligible, notes, sent_to_kitchen, line_total)
      VALUES (@sale_id, @product_id, @name, @price, @qty, @discount, @tax_rate, @tax_amount, @vat_exempt_amount, @sc_pwd_eligible, @notes, 1, @line_total)
    `);
    for (const item of sale.items) {
      if (item.voided) continue;
      // A line can be partially eligible (e.g. 2 of 3 units consumed by the
      // cardholder) — split it into two rows, one per eligible/regular
      // sub-quantity, so the receipt/records reflect the real breakdown.
      // Total qty across the split never changes, so stock (already
      // deducted when this round was sent to the kitchen) isn't affected.
      const eligibleQty = scPwdType !== 'none' ? Math.max(0, Math.min(eligibilityByItem[item.id] || 0, item.qty)) : 0;
      const regularQty = item.qty - eligibleQty;

      if (eligibleQty > 0 && regularQty > 0) {
        const reg = computeSaleLine({ price: item.price, qty: regularQty, taxRate: item.tax_rate, manualDiscount: 0, scPwdEligible: false });
        updateItem.run(regularQty, reg.discount, reg.taxAmount, reg.vatExemptAmount, 0, reg.lineTotal, item.id);

        const elig = computeSaleLine({ price: item.price, qty: eligibleQty, taxRate: item.tax_rate, manualDiscount: 0, scPwdEligible: true });
        insertSplitItem.run({
          sale_id: sale.id, product_id: item.product_id, name: item.name, price: item.price, qty: eligibleQty,
          discount: elig.discount, tax_rate: item.tax_rate, tax_amount: elig.taxAmount,
          vat_exempt_amount: elig.vatExemptAmount, sc_pwd_eligible: 1, notes: item.notes, line_total: elig.lineTotal,
        });
      } else {
        const scPwdEligible = eligibleQty > 0;
        const { discount, taxAmount, vatExemptAmount, lineTotal } = computeSaleLine({
          price: item.price, qty: item.qty, taxRate: item.tax_rate, manualDiscount: 0, scPwdEligible,
        });
        updateItem.run(item.qty, discount, taxAmount, vatExemptAmount, scPwdEligible ? 1 : 0, lineTotal, item.id);
      }
    }
    recomputeSaleTotals(sale.id);

    const fresh = db.prepare('SELECT total FROM sales WHERE id = ?').get(sale.id);
    const paidTotal = payments.reduce((s, p) => s + Number(p.amount), 0);
    if (paidTotal + 0.005 < fresh.total) {
      throw new Error(`Payment total (${paidTotal.toFixed(2)}) is less than order total (${fresh.total.toFixed(2)})`);
    }

    const changeGiven = recordPayments(sale.id, payments);

    // shift_id reflects whoever's drawer the cash actually lands in — the
    // shift open at billing time, not whichever shift was open when the
    // order was first placed (could be a different staff member/hours earlier).
    db.prepare(`
      UPDATE sales SET order_status = 'billed', status = 'completed', shift_id = ?, billed_at = datetime('now'),
        discount_type = ?, discount_id_number = ?, discount_holder_name = ?, customer_id = COALESCE(?, customer_id)
      WHERE id = ?
    `).run(
      shift ? shift.id : null, scPwdType,
      scPwdType !== 'none' ? discount_id_number : null, scPwdType !== 'none' ? discount_holder_name : null,
      customer_id || null, sale.id
    );

    if (customer_id) {
      db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(Math.floor(fresh.total / 100), customer_id);
    }

    return { changeGiven };
  });

  try {
    tx();
    res.json(getSaleDetail(sale.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Finalized (billed) sales history — open table orders live in /api/tables
// and are not "sales" yet, so they're excluded here.
router.get('/', (req, res) => {
  const { period, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Number(req.query.pageSize) || Number(req.query.limit) || 50);
  const wantsDateFilter = period || (req.query.from && req.query.to);
  const { from, to } = wantsDateFilter ? dateRange(period, req.query.from, req.query.to) : {};

  let where = `WHERE s.order_status = 'billed'`;
  const params = [];
  if (from) { where += ' AND s.created_at >= ?'; params.push(from); }
  if (to) { where += ' AND s.created_at <= ?'; params.push(to); }
  if (status) { where += ' AND s.status = ?'; params.push(status); }

  const total = db.prepare(`SELECT COUNT(*) as n FROM sales s ${where}`).get(...params).n;
  const sales = db.prepare(`
    SELECT s.*, u.name as cashier_name, c.name as customer_name, t.name as table_name
    FROM sales s LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN tables t ON t.id = s.table_id
    ${where}
    ORDER BY s.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  res.json({ sales, total, page, pageSize });
});

// Open table orders (not yet billed) — for the table order screen.
router.get('/table/:tableId/open', (req, res) => {
  const sale = db.prepare(`SELECT id FROM sales WHERE table_id = ? AND order_status = 'open'`).get(req.params.tableId);
  res.json(sale ? getSaleDetail(sale.id) : null);
});

router.get('/:id', (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  res.json(sale);
});

// ---- Void ----
router.post('/:id/void', requireRole('admin', 'manager'), (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const isOpenOrder = sale.order_status === 'open';
  if (!isOpenOrder && sale.status !== 'completed') return res.status(400).json({ error: `Sale is already ${sale.status}` });

  const tx = db.transaction(() => {
    // order_status is set to 'billed' even for a void so the table frees up
    // (occupancy is derived from order_status = 'open', not from status).
    db.prepare(`UPDATE sales SET status = 'voided', order_status = 'billed' WHERE id = ?`).run(sale.id);
    const restock = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1');
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
      VALUES (?, ?, 'void', ?, ?)
    `);
    for (const item of sale.items) {
      // Already-voided items (e.g. removed from an open order via the
      // edit-with-approval flow before billing) never contributed to stock
      // deduction or the sale total in the first place — restocking them
      // again here would double-count.
      if (item.voided) continue;
      if (item.product_id) {
        restock.run(item.qty, item.product_id);
        insertMovement.run(item.product_id, item.qty, sale.sale_number, req.session.userId);
      }
    }

    // Points were only ever awarded once this sale was billed (open orders
    // never earned any) — claw them back so voiding a paid sale doesn't leave
    // the customer with loyalty points for an order that no longer happened.
    if (!isOpenOrder && sale.customer_id) {
      db.prepare('UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?) WHERE id = ?')
        .run(Math.floor(sale.total / 100), sale.customer_id);
    }
  });
  tx();
  res.json(getSaleDetail(sale.id));
});

// ---- Refund (full or partial by line item) ----
router.post('/:id/refund', requireRole('admin', 'manager'), (req, res) => {
  const { items, reason, method } = req.body; // items: [{ sale_item_id, qty }]
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (sale.status === 'voided') return res.status(400).json({ error: 'Cannot refund a voided sale' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items are required' });

  const tx = db.transaction(() => {
    let refundAmount = 0;
    const refundInfo = db.prepare(`
      INSERT INTO refunds (original_sale_id, user_id, amount, method, reason)
      VALUES (?, ?, 0, ?, ?)
    `).run(sale.id, req.session.userId, method || 'cash', reason || null);
    const refundId = refundInfo.lastInsertRowid;

    const insertRefundItem = db.prepare(`
      INSERT INTO refund_items (refund_id, sale_item_id, qty, amount) VALUES (?, ?, ?, ?)
    `);
    const restock = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1');
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
      VALUES (?, ?, 'refund', ?, ?)
    `);
    const updateRefundedQty = db.prepare('UPDATE sale_items SET refunded_qty = refunded_qty + ? WHERE id = ?');

    for (const reqItem of items) {
      const saleItem = sale.items.find((si) => si.id === reqItem.sale_item_id);
      if (!saleItem) throw new Error(`Sale item ${reqItem.sale_item_id} not found on this sale`);
      // A voided item (removed from an open order before billing) was never
      // charged or counted in the sale total — refunding it would hand back
      // money for something the customer never paid for.
      if (saleItem.voided) throw new Error(`${saleItem.name} was removed from this order and was never charged`);
      const qty = Number(reqItem.qty);
      const remaining = saleItem.qty - saleItem.refunded_qty;
      if (qty <= 0 || qty > remaining) throw new Error(`Invalid refund qty for ${saleItem.name} (remaining: ${remaining})`);
      const unitTotal = saleItem.line_total / saleItem.qty;
      const amount = unitTotal * qty;
      refundAmount += amount;
      insertRefundItem.run(refundId, saleItem.id, qty, amount);
      updateRefundedQty.run(qty, saleItem.id);
      if (saleItem.product_id) {
        restock.run(qty, saleItem.product_id);
        insertMovement.run(saleItem.product_id, qty, sale.sale_number, req.session.userId);
      }
    }

    db.prepare('UPDATE refunds SET amount = ? WHERE id = ?').run(refundAmount, refundId);

    // Claw back the share of loyalty points this refund represents, so a
    // refunded order doesn't leave points behind for money the customer got back.
    if (sale.customer_id) {
      db.prepare('UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?) WHERE id = ?')
        .run(Math.floor(refundAmount / 100), sale.customer_id);
    }

    // Voided items (removed before billing) were never charged and can never
    // be refunded, so they'd otherwise permanently block "fully refunded"
    // status — only chargeable items count toward that.
    const allItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    const chargeableItems = allItems.filter((i) => !i.voided);
    const fullyRefunded = chargeableItems.length > 0 && chargeableItems.every((i) => i.refunded_qty >= i.qty);
    db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(fullyRefunded ? 'refunded' : 'partially_refunded', sale.id);

    return refundId;
  });

  try {
    const refundId = tx();
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
    refund.items = db.prepare('SELECT * FROM refund_items WHERE refund_id = ?').all(refundId);
    res.json({ refund, sale: getSaleDetail(sale.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Receipt data ----
function buildReceiptPayload(sale) {
  return {
    storeName: getSetting('store_name', 'Store'),
    storeAddress: getSetting('store_address', ''),
    storePhone: getSetting('store_phone', ''),
    storeTin: getSetting('store_tin', ''),
    storeLogo: getSetting('store_logo', ''),
    saleNumber: sale.sale_number,
    createdAt: sale.created_at,
    cashierName: sale.cashier_name,
    customerName: sale.customer_name,
    tableName: sale.table_name,
    items: sale.items.filter((i) => !i.voided).map((i) => ({
      name: i.name, qty: i.qty, price: i.price, lineTotal: i.line_total,
    })),
    subtotal: sale.subtotal,
    discountTotal: sale.discount_total,
    taxTotal: sale.tax_total,
    vatExemptTotal: sale.vat_exempt_total,
    total: sale.total,
    payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount, changeGiven: p.change_given })),
    footer: getSetting('receipt_footer', 'Thank you!'),
    discountType: sale.discount_type,
    discountIdNumber: sale.discount_id_number,
    discountHolderName: sale.discount_holder_name,
  };
}

router.get('/:id/receipt', (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  res.json(buildReceiptPayload(sale));
});

router.post('/:id/receipt/print', async (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const enabled = getSetting('thermal_printer_enabled', 'false') === 'true';
  if (!enabled) return res.status(400).json({ error: 'Thermal printer is not enabled in Settings. Use browser printing instead.' });
  const target = getSetting('thermal_printer_target', '');
  if (!target) return res.status(400).json({ error: 'Thermal printer target (host:port) is not set in Settings.' });
  const width = getSetting('receipt_paper_width', '58mm') === '80mm' ? 42 : 32;
  const data = buildEscPosReceipt(buildReceiptPayload(sale), width);
  try {
    await sendToNetworkPrinter(target, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `Failed to print: ${e.message}` });
  }
});

router.post('/:id/receipt/email', async (req, res) => {
  const sale = getSaleDetail(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const to = req.body.email || sale.customer_email;
  if (!to) return res.status(400).json({ error: 'No email address provided or on file for this customer' });
  if (!mailer.isConfigured()) return res.status(400).json({ error: 'Email is not configured. Set SMTP settings in .env (see README).' });
  const payload = buildReceiptPayload(sale);
  const text = buildPlainTextReceipt(payload, 40);
  const logoHtml = payload.storeLogo
    ? `<img src="${payload.storeLogo}" alt="${payload.storeName}" style="max-width:160px;max-height:160px;display:block;margin:0 auto 10px;">`
    : '';
  try {
    await mailer.sendReceiptEmail({
      to,
      subject: `Receipt ${sale.sale_number} - ${payload.storeName}`,
      text,
      html: `<div style="text-align:center;font-family:sans-serif;">${logoHtml}</div><pre style="font-family:monospace">${text.replace(/</g, '&lt;')}</pre>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
