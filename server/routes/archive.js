const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'manager'));

// The two most recent calendar years (including the current one) stay in the
// live tables; anything older is eligible to move into the *_archive tables.
const HOT_YEARS = 2;
const archiveDir = path.join(__dirname, '..', '..', 'data', 'archives');

function isEligibleYear(year) {
  return year <= new Date().getFullYear() - HOT_YEARS;
}

// Grouped and archived by billed_at, not created_at — matching reports.js,
// which buckets revenue by when payment was actually taken so a dine-in
// order opened one day and paid the next lands in the right year/period.
router.get('/years', (req, res) => {
  const currentYear = new Date().getFullYear();
  const liveYears = db.prepare(`
    SELECT strftime('%Y', billed_at) as year, COUNT(*) as n
    FROM sales WHERE order_status = 'billed'
    GROUP BY year ORDER BY year DESC
  `).all().map((r) => ({ year: Number(r.year), count: r.n, eligible: isEligibleYear(Number(r.year)) }));

  const archived = db.prepare(`
    SELECT ar.year, ar.sale_count, ar.file_path, ar.archived_at, u.name as archived_by_name
    FROM archive_runs ar LEFT JOIN users u ON u.id = ar.archived_by
    ORDER BY ar.year DESC
  `).all();

  res.json({ currentYear, hotFromYear: currentYear - HOT_YEARS + 1, liveYears, archived });
});

// Admin can view archived years/sales (router-level gate above) but
// triggering a new archive run is a write action reserved for managers.
router.post('/:year', requireRole('manager'), (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) return res.status(400).json({ error: 'Invalid year' });
  if (!isEligibleYear(year)) return res.status(400).json({ error: `${year} is still within the ${HOT_YEARS}-year hot window and can't be archived yet.` });
  if (db.prepare('SELECT 1 FROM archive_runs WHERE year = ?').get(year)) return res.status(400).json({ error: `${year} has already been archived.` });

  const from = `${year}-01-01 00:00:00`;
  const to = `${year}-12-31 23:59:59`;
  const sales = db.prepare(`SELECT * FROM sales WHERE order_status = 'billed' AND billed_at BETWEEN ? AND ?`).all(from, to);
  if (sales.length === 0) return res.status(400).json({ error: `No records found for ${year}.` });

  const saleIds = sales.map((s) => s.id);
  const inSaleIds = saleIds.map(() => '?').join(',');
  const saleItems = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${inSaleIds})`).all(...saleIds);
  const payments = db.prepare(`SELECT * FROM payments WHERE sale_id IN (${inSaleIds})`).all(...saleIds);
  const refunds = db.prepare(`SELECT * FROM refunds WHERE original_sale_id IN (${inSaleIds})`).all(...saleIds);
  const refundIds = refunds.map((r) => r.id);
  const refundItems = refundIds.length
    ? db.prepare(`SELECT * FROM refund_items WHERE refund_id IN (${refundIds.map(() => '?').join(',')})`).all(...refundIds)
    : [];

  // Write the export first — an independent, human-readable copy for BIR audits
  // or disaster recovery — and verify it round-trips before touching live data.
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const filePath = path.join(archiveDir, `${year}.json`);
  const payload = { year, generated_at: new Date().toISOString(), sales, sale_items: saleItems, payments, refunds, refund_items: refundItems };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  const verify = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (verify.sales.length !== sales.length || verify.sale_items.length !== saleItems.length || verify.payments.length !== payments.length) {
    return res.status(500).json({ error: 'Archive export verification failed — no records were moved.' });
  }

  const insertSaleArchive = db.prepare(`
    INSERT INTO sales_archive (id, sale_number, user_id, customer_id, shift_id, channel_id, subtotal, discount_total, tax_total, vat_exempt_total, total, status, order_status, table_id, register_slot_id, discount_type, discount_id_number, discount_holder_name, note, created_at, billed_at)
    VALUES (@id, @sale_number, @user_id, @customer_id, @shift_id, @channel_id, @subtotal, @discount_total, @tax_total, @vat_exempt_total, @total, @status, @order_status, @table_id, @register_slot_id, @discount_type, @discount_id_number, @discount_holder_name, @note, @created_at, @billed_at)
  `);
  const insertItemArchive = db.prepare(`
    INSERT INTO sale_items_archive (id, sale_id, product_id, name, price, qty, discount, tax_rate, tax_amount, vat_exempt_amount, sc_pwd_eligible, notes, sent_to_kitchen, line_total, voided, refunded_qty)
    VALUES (@id, @sale_id, @product_id, @name, @price, @qty, @discount, @tax_rate, @tax_amount, @vat_exempt_amount, @sc_pwd_eligible, @notes, @sent_to_kitchen, @line_total, @voided, @refunded_qty)
  `);
  const insertPaymentArchive = db.prepare(`
    INSERT INTO payments_archive (id, sale_id, method, amount, tendered, change_given, reference, created_at)
    VALUES (@id, @sale_id, @method, @amount, @tendered, @change_given, @reference, @created_at)
  `);
  const insertRefundArchive = db.prepare(`
    INSERT INTO refunds_archive (id, original_sale_id, refund_sale_number, user_id, amount, method, reason, created_at)
    VALUES (@id, @original_sale_id, @refund_sale_number, @user_id, @amount, @method, @reason, @created_at)
  `);
  const insertRefundItemArchive = db.prepare(`
    INSERT INTO refund_items_archive (id, refund_id, sale_item_id, qty, amount)
    VALUES (@id, @refund_id, @sale_item_id, @qty, @amount)
  `);
  const delRefundItems = db.prepare(`DELETE FROM refund_items WHERE refund_id = ?`);
  const delRefund = db.prepare(`DELETE FROM refunds WHERE id = ?`);
  const delPayments = db.prepare(`DELETE FROM payments WHERE sale_id = ?`);
  const delItems = db.prepare(`DELETE FROM sale_items WHERE sale_id = ?`);
  const delSale = db.prepare(`DELETE FROM sales WHERE id = ?`);
  const insertRun = db.prepare(`
    INSERT INTO archive_runs (year, sale_count, sale_item_count, payment_count, refund_count, refund_item_count, file_path, archived_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const s of sales) insertSaleArchive.run(s);
    for (const i of saleItems) insertItemArchive.run(i);
    for (const p of payments) insertPaymentArchive.run(p);
    for (const r of refunds) insertRefundArchive.run(r);
    for (const ri of refundItems) insertRefundItemArchive.run(ri);

    // Delete children before parents to satisfy foreign key constraints.
    for (const r of refunds) { delRefundItems.run(r.id); delRefund.run(r.id); }
    for (const id of saleIds) { delPayments.run(id); delItems.run(id); delSale.run(id); }

    insertRun.run(year, sales.length, saleItems.length, payments.length, refunds.length, refundItems.length, filePath, req.session.userId);
  });
  tx();

  res.json({ ok: true, year, sale_count: sales.length, file_path: filePath });
});

router.get('/:year/download', (req, res) => {
  const run = db.prepare('SELECT * FROM archive_runs WHERE year = ?').get(req.params.year);
  if (!run) return res.status(404).json({ error: 'That year has not been archived.' });
  res.download(run.file_path, `sales-archive-${run.year}.json`);
});

router.get('/:year/sales', (req, res) => {
  const year = Number(req.params.year);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Number(req.query.pageSize) || 50);
  const from = `${year}-01-01 00:00:00`;
  const to = `${year}-12-31 23:59:59`;

  const total = db.prepare(`SELECT COUNT(*) as n FROM sales_archive WHERE billed_at BETWEEN ? AND ?`).get(from, to).n;
  const sales = db.prepare(`
    SELECT sa.*, u.name as cashier_name, c.name as customer_name, COALESCE(t.name, rs.name) as table_name
    FROM sales_archive sa
    LEFT JOIN users u ON u.id = sa.user_id
    LEFT JOIN customers c ON c.id = sa.customer_id
    LEFT JOIN tables t ON t.id = sa.table_id
    LEFT JOIN register_slots rs ON rs.id = sa.register_slot_id
    WHERE sa.billed_at BETWEEN ? AND ?
    ORDER BY sa.id DESC
    LIMIT ? OFFSET ?
  `).all(from, to, pageSize, (page - 1) * pageSize);

  res.json({ sales, total, page, pageSize });
});

router.get('/sales/:id', (req, res) => {
  const sale = db.prepare(`
    SELECT sa.*, u.name as cashier_name, c.name as customer_name, COALESCE(t.name, rs.name) as table_name
    FROM sales_archive sa
    LEFT JOIN users u ON u.id = sa.user_id
    LEFT JOIN customers c ON c.id = sa.customer_id
    LEFT JOIN tables t ON t.id = sa.table_id
    LEFT JOIN register_slots rs ON rs.id = sa.register_slot_id
    WHERE sa.id = ?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found in archive' });
  sale.items = db.prepare('SELECT * FROM sale_items_archive WHERE sale_id = ?').all(sale.id);
  sale.payments = db.prepare('SELECT * FROM payments_archive WHERE sale_id = ?').all(sale.id);
  res.json(sale);
});

module.exports = router;
