const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { buildZReadingEscPos, sendToNetworkPrinter } = require('../lib/receipt');

const router = express.Router();
// Waiters never touch the cash drawer at all.
router.use(requireAuth, requireRole('admin', 'manager', 'cashier'));

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// A shift is one person's cash drawer — only its owner or a manager/admin
// may *view* it (summary, pending orders). Without this, any logged-in
// cashier could inspect a co-worker's drawer just by guessing the shift ID.
function canAccessShift(req, shift) {
  return shift.user_id === req.session.userId || ['admin', 'manager'].includes(req.session.role);
}

// Only the owning cashier can actually open/close it — admin/manager are
// view-only on the cash drawer (they can see the current cashier's drawer,
// but not open, close, or otherwise transact on it).
function canCloseShift(req, shift) {
  return shift.user_id === req.session.userId;
}

router.get('/current', (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(req.session.userId);
  res.json(shift || null);
});

// Admin/manager have no shift of their own (and can't open one) — this is
// what their read-only Cash Drawer view watches instead: whichever cashier
// currently has the drawer open, if any. Only one cashier can be on shift at
// a time, so there's at most one row to find.
router.get('/active', requireRole('admin', 'manager'), (req, res) => {
  const shift = db.prepare(`
    SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id
    WHERE sh.status = 'open' ORDER BY sh.id DESC LIMIT 1
  `).get();
  if (!shift) return res.json(null);
  res.json({ ...shift, summary: computeShiftSummary(shift.id, shift.opening_cash) });
});

// Only a cashier can open a shift — admin/manager are view-only on the
// register/tables regardless, so a shift would be useless to them. Only one
// cashier can be on shift at a time (one physical cash drawer), so a second
// cashier can't open their own until the first closes out.
router.post('/open', requireRole('cashier'), (req, res) => {
  const existing = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open'`).get(req.session.userId);
  if (existing) return res.status(400).json({ error: 'A shift is already open for this user' });
  const otherOpen = db.prepare(`
    SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.status = 'open'
  `).get();
  if (otherOpen) return res.status(400).json({ error: `${otherOpen.user_name} already has the cash drawer open. Only one cashier can be on shift at a time.` });
  const openingCash = Number(req.body.opening_cash) || 0;
  if (openingCash < 0) return res.status(400).json({ error: 'Opening cash cannot be negative' });
  const info = db.prepare('INSERT INTO shifts (user_id, opening_cash) VALUES (?, ?)').run(req.session.userId, openingCash);
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid));
});

// Table orders still open (not yet billed) under a shift — used to warn
// before closing, and to report what got carried over after.
function getPendingOrders(shiftId) {
  return db.prepare(`
    SELECT s.id, s.sale_number, s.total, s.created_at, COALESCE(t.name, rs.name) as table_name,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0) as item_count
    FROM sales s
    LEFT JOIN tables t ON t.id = s.table_id
    LEFT JOIN register_slots rs ON rs.id = s.register_slot_id
    WHERE s.shift_id = ? AND s.order_status = 'open'
    ORDER BY s.created_at
  `).all(shiftId);
}

// Lets the close confirmation warn about pending orders before committing.
router.get('/:id/pending-orders', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!canAccessShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(getPendingOrders(req.params.id));
});

// Z-Reading: end-of-day / end-of-shift summary + close out the shift
router.post('/:id/close', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!canCloseShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
  if (shift.status === 'closed') return res.status(400).json({ error: 'Shift already closed' });

  const closingCash = Number(req.body.closing_cash);
  if (!Number.isFinite(closingCash) || closingCash < 0) {
    return res.status(400).json({ error: 'Counted cash must be a valid, non-negative amount' });
  }

  const summary = computeShiftSummary(shift.id, shift.opening_cash);
  const diff = closingCash - summary.expectedCash;

  // Still-open table orders don't belong to a closed drawer — detach them
  // (shift_id = NULL) so they're explicitly "unclaimed" rather than silently
  // pointing at a shift that's finished. Whoever bills them later picks them
  // up under their own open shift (see /:id/bill), and the Tables view flags
  // them in the meantime so they aren't forgotten.
  const carriedOverOrders = getPendingOrders(shift.id);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE shifts SET status = 'closed', closing_cash = ?, expected_cash = ?, cash_diff = ?, closed_at = datetime('now')
      WHERE id = ?
    `).run(closingCash, summary.expectedCash, diff, shift.id);
    db.prepare(`UPDATE sales SET shift_id = NULL WHERE shift_id = ? AND order_status = 'open'`).run(shift.id);
  });
  tx();

  res.json({
    ...summary, closingCash, cashDiff: diff,
    shift: db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id),
    carriedOverOrders,
  });
});

function computeShiftSummary(shiftId, openingCash) {
  // order_status='billed' guards against an open (unpaid) table order that
  // happens to carry this shift_id — shift_id is only meant to represent
  // completed, paid sales for cash-drawer reconciliation purposes.
  const sales = db.prepare(`SELECT * FROM sales WHERE shift_id = ? AND status != 'voided' AND order_status = 'billed'`).all(shiftId);
  const saleIds = sales.map((s) => s.id);
  let grossSales = 0, discounts = 0, tax = 0, refunds = 0;
  const byMethod = {};

  for (const s of sales) {
    grossSales += s.subtotal;
    discounts += s.discount_total;
    tax += s.tax_total;
  }

  if (saleIds.length > 0) {
    const placeholders = saleIds.map(() => '?').join(',');
    // payments.amount is already the net portion of the sale total covered by
    // this payment (change_given separately records cash handed back from the
    // tendered amount), so it already reflects what stays in the drawer.
    const payments = db.prepare(`
      SELECT method, SUM(amount) as total
      FROM payments WHERE sale_id IN (${placeholders}) GROUP BY method
    `).all(...saleIds);
    for (const p of payments) byMethod[p.method] = p.total;

    const refundRows = db.prepare(`SELECT method, SUM(amount) as total FROM refunds WHERE original_sale_id IN (${placeholders}) GROUP BY method`).all(...saleIds);
    for (const r of refundRows) refunds += r.total;
  }

  const netSales = sales.reduce((s, sale) => s + sale.total, 0) - refunds;
  const cashSales = byMethod.cash || 0;
  const cashRefunds = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM refunds WHERE method = 'cash' AND original_sale_id IN (${saleIds.length ? saleIds.map(() => '?').join(',') : '-1'})`).get(...saleIds).t;
  const expectedCash = openingCash + cashSales - cashRefunds;

  return {
    shiftId,
    saleCount: sales.length,
    grossSales, discounts, tax, refunds, netSales,
    byMethod,
    openingCash, expectedCash,
  };
}

router.get('/:id/summary', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!canAccessShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
  res.json(computeShiftSummary(shift.id, shift.opening_cash));
});

// Z-Reading on the same thermal receipt printer sales/kitchen tickets use —
// same enabled/target checks and same "Print (browser)" + "Print (thermal)"
// UI pairing as a sale receipt, so staff aren't left guessing which printer
// window.print() will land on.
router.post('/:id/receipt/print', async (req, res) => {
  const shift = db.prepare(`SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.id = ?`).get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!canAccessShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
  const enabled = getSetting('thermal_printer_enabled', 'false') === 'true';
  if (!enabled) return res.status(400).json({ error: 'Thermal printer is not enabled in Settings. Use browser printing instead.' });
  const target = getSetting('thermal_printer_target', '');
  if (!target) return res.status(400).json({ error: 'Thermal printer target (host:port) is not set in Settings.' });
  const width = getSetting('receipt_paper_width', '58mm') === '80mm' ? 42 : 32;

  const summary = computeShiftSummary(shift.id, shift.opening_cash);
  const data = buildZReadingEscPos({
    storeName: getSetting('store_name', 'Store'),
    storeAddress: getSetting('store_address', ''),
    storePhone: getSetting('store_phone', ''),
    storeTin: getSetting('store_tin', ''),
    userName: shift.user_name,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    closingCash: shift.closing_cash,
    cashDiff: shift.cash_diff,
    ...summary,
  }, width);

  try {
    await sendToNetworkPrinter(target, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `Failed to print: ${e.message}` });
  }
});

// Individual transactions billed under this shift — what the cashier's
// aggregate summary above is actually made of. Includes voided/refunded
// sales too (flagged by status) so the list matches what really happened,
// not just what counts toward the cash total.
router.get('/:id/sales', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (!canAccessShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(`
    SELECT s.id, s.sale_number, s.total, s.status, s.billed_at, COALESCE(t.name, rs.name) as table_name, c.name as customer_name
    FROM sales s
    LEFT JOIN tables t ON t.id = s.table_id
    LEFT JOIN register_slots rs ON rs.id = s.register_slot_id
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.shift_id = ? AND s.order_status = 'billed'
    ORDER BY s.billed_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Cash Drawer's Shift History table — admin/manager oversight only. Cashiers
// are cash-drawer full-access but not shift history; their own current
// shift is still visible via /current and /:id/summary while it's open.
// Paginated (not just a flat LIMIT) so a shift from months back is still
// reachable — shifts are never archived like sales are, so every one that's
// ever happened lives in this same table indefinitely.
router.get('/', requireRole('admin', 'manager'), (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const total = db.prepare('SELECT COUNT(*) c FROM shifts').get().c;
  const shifts = db.prepare(`
    SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id
    ORDER BY sh.id DESC LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize);
  res.json({ shifts, total });
});

module.exports = router;
