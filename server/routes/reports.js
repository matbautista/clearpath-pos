const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { dateRange } = require('../lib/dateRange');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'manager'));

// Revenue is bucketed by billed_at (when payment was actually taken), not
// created_at (when a table's tab may have first been opened) — otherwise a
// dine-in order opened one day and paid the next would land in the wrong
// day's report. Open (unpaid) table orders are excluded entirely.

router.get('/summary', (req, res) => {
  const { period = 'today', from: qFrom, to: qTo } = req.query;
  const { from, to } = dateRange(period, qFrom, qTo);

  const sales = db.prepare(`SELECT * FROM sales WHERE billed_at BETWEEN ? AND ? AND status != 'voided'`).all(from, to);
  const revenue = sales.reduce((s, x) => s + x.total, 0);
  const orders = sales.length;
  const avgOrder = orders ? revenue / orders : 0;

  const refunds = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM refunds WHERE created_at BETWEEN ? AND ?
  `).get(from, to).total;

  // p.amount is already the net portion of the sale total covered by this
  // payment (change_given is separately how much cash was handed back from
  // the tendered amount) — do not subtract it again here.
  const byMethod = db.prepare(`
    SELECT p.method, SUM(p.amount) as total FROM payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE s.billed_at BETWEEN ? AND ? AND s.status != 'voided'
    GROUP BY p.method
  `).all(from, to);

  // Revenue is gross (what the customer paid); commission_amount is the cut
  // a delivery platform keeps, so net_revenue is what actually lands with
  // the restaurant. Walk-in carries 0% commission by default.
  const byChannel = db.prepare(`
    SELECT ch.id, ch.name, ch.commission_rate, COUNT(s.id) as orders, COALESCE(SUM(s.total), 0) as revenue
    FROM sales s JOIN channels ch ON ch.id = s.channel_id
    WHERE s.billed_at BETWEEN ? AND ? AND s.status != 'voided'
    GROUP BY ch.id
    ORDER BY revenue DESC
  `).all(from, to).map((r) => ({
    ...r,
    commission_amount: r.revenue * r.commission_rate,
    net_revenue: r.revenue - r.revenue * r.commission_rate,
  }));

  res.json({ from, to, revenue, orders, avgOrder, refunds, byMethod, byChannel });
});

router.get('/top-products', (req, res) => {
  const { period = 'week', from: qFrom, to: qTo, limit = 10 } = req.query;
  const { from, to } = dateRange(period, qFrom, qTo);
  const rows = db.prepare(`
    SELECT si.product_id, si.name, SUM(si.qty) as qty_sold, SUM(si.line_total) as revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.billed_at BETWEEN ? AND ? AND s.status != 'voided' AND si.voided = 0
    GROUP BY si.product_id, si.name
    ORDER BY qty_sold DESC
    LIMIT ?
  `).all(from, to, Number(limit));
  res.json(rows);
});

router.get('/hourly', (req, res) => {
  const { period = 'today', from: qFrom, to: qTo } = req.query;
  const { from, to } = dateRange(period, qFrom, qTo);
  const rows = db.prepare(`
    SELECT strftime('%H', billed_at) as hour, COUNT(*) as orders, SUM(total) as revenue
    FROM sales
    WHERE billed_at BETWEEN ? AND ? AND status != 'voided'
    GROUP BY hour ORDER BY hour
  `).all(from, to);
  res.json(rows);
});

router.get('/daily', (req, res) => {
  const { period = 'month', from: qFrom, to: qTo } = req.query;
  const { from, to } = dateRange(period, qFrom, qTo);
  const rows = db.prepare(`
    SELECT date(billed_at) as day, COUNT(*) as orders, SUM(total) as revenue
    FROM sales
    WHERE billed_at BETWEEN ? AND ? AND status != 'voided'
    GROUP BY day ORDER BY day
  `).all(from, to);
  res.json(rows);
});

// All-time per-customer purchase summary — powers the Customers section of
// Reports > Metrics (top spenders, recurring buyers, most consistent).
// active_weeks (distinct calendar weeks with at least one order) is the
// consistency signal: many orders bunched in one week isn't "consistent",
// showing up across many different weeks is.
// Archived years live in sales_archive, not sales — union both so "all-time"
// doesn't quietly shrink once old years get archived. See archive.js.
router.get('/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.phone,
      COUNT(s.total) as order_count,
      COALESCE(SUM(s.total), 0) as total_spent,
      MIN(s.billed_at) as first_order,
      MAX(s.billed_at) as last_order,
      COUNT(DISTINCT strftime('%Y-%W', s.billed_at)) as active_weeks
    FROM customers c
    JOIN (
      SELECT customer_id, total, billed_at, status FROM sales
      UNION ALL
      SELECT customer_id, total, billed_at, status FROM sales_archive
    ) s ON s.customer_id = c.id AND s.status != 'voided'
    GROUP BY c.id
    ORDER BY total_spent DESC
  `).all();
  res.json(rows);
});

// All-time revenue/commission per channel — powers the Channels card in
// Reports > Metrics > Sales. Includes every active channel (even with zero
// sales, so a newly added one shows up at ₱0) plus any inactive channel that
// still has sales history — deactivating a channel in Settings must not
// erase its past revenue from reporting, only stop it appearing at checkout.
router.get('/channels', (req, res) => {
  const rows = db.prepare(`
    SELECT ch.id, ch.name, ch.commission_rate, ch.active,
      COUNT(s.total) as order_count,
      COALESCE(SUM(s.total), 0) as revenue
    FROM channels ch
    LEFT JOIN (
      SELECT channel_id, total, status FROM sales
      UNION ALL
      SELECT channel_id, total, status FROM sales_archive
    ) s ON s.channel_id = ch.id AND s.status != 'voided'
    GROUP BY ch.id
    HAVING ch.active = 1 OR order_count > 0
    ORDER BY revenue DESC
  `).all().map((r) => ({
    ...r,
    commission_amount: r.revenue * r.commission_rate,
    net_revenue: r.revenue - r.revenue * r.commission_rate,
  }));
  res.json(rows);
});

module.exports = router;
