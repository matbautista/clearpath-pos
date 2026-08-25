const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// A shift is one person's cash drawer — only its owner or a manager/admin
// may view or close it. Without this, any logged-in cashier could close (or
// fabricate a cash count for) a co-worker's shift just by guessing the ID.
function canAccessShift(req, shift) {
  return shift.user_id === req.session.userId || ['admin', 'manager'].includes(req.session.role);
}

router.get('/current', (req, res) => {
  const shift = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(req.session.userId);
  res.json(shift || null);
});

router.post('/open', (req, res) => {
  const existing = db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open'`).get(req.session.userId);
  if (existing) return res.status(400).json({ error: 'A shift is already open for this user' });
  const openingCash = Number(req.body.opening_cash) || 0;
  if (openingCash < 0) return res.status(400).json({ error: 'Opening cash cannot be negative' });
  const info = db.prepare('INSERT INTO shifts (user_id, opening_cash) VALUES (?, ?)').run(req.session.userId, openingCash);
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid));
});

// Table orders still open (not yet billed) under a shift — used to warn
// before closing, and to report what got carried over after.
function getPendingOrders(shiftId) {
  return db.prepare(`
    SELECT s.id, s.sale_number, s.total, s.created_at, t.name as table_name,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0) as item_count
    FROM sales s LEFT JOIN tables t ON t.id = s.table_id
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
  if (!canAccessShift(req, shift)) return res.status(403).json({ error: 'Insufficient permissions' });
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

// Cashiers only see their own shift history here (their cash_diff is their
// own business); admin/manager see everyone's, for oversight.
router.get('/', (req, res) => {
  const isManager = ['admin', 'manager'].includes(req.session.role);
  const rows = isManager
    ? db.prepare(`SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id ORDER BY sh.id DESC LIMIT 50`).all()
    : db.prepare(`SELECT sh.*, u.name as user_name FROM shifts sh JOIN users u ON u.id = sh.user_id WHERE sh.user_id = ? ORDER BY sh.id DESC LIMIT 50`).all(req.session.userId);
  res.json(rows);
});

module.exports = router;
