const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { q } = req.query;
  if (q) {
    const rows = db.prepare(`
      SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY name
    `).all(`%${q}%`, `%${q}%`, `%${q}%`);
    return res.json(rows);
  }
  res.json(db.prepare('SELECT * FROM customers ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  // Archived years live in sales_archive, not sales — union both so a
  // longtime customer's history doesn't appear to end the day their older
  // orders get archived. See server/routes/archive.js.
  const purchases = db.prepare(`
    SELECT id, sale_number, total, status, created_at FROM (
      SELECT id, sale_number, total, status, created_at FROM sales WHERE customer_id = ?
      UNION ALL
      SELECT id, sale_number, total, status, created_at FROM sales_archive WHERE customer_id = ?
    ) ORDER BY id DESC LIMIT 25
  `).all(req.params.id, req.params.id);
  res.json({ ...customer, purchases });
});

router.post('/', requireRole('manager', 'waiter'), (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO customers (name, phone, email, notes) VALUES (?, ?, ?, ?)').run(name, phone || null, email || null, notes || null);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', requireRole('manager', 'waiter'), (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  const fields = ['name', 'phone', 'email', 'notes', 'loyalty_points'];
  const updates = {};
  for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (setClause) db.prepare(`UPDATE customers SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireRole('manager', 'waiter'), (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
