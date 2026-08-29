const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// Lists all active register (customer) slots along with a summary of their
// current open order (if any) — the Register's counterpart to GET
// /api/tables, since a walk-in order has no physical table to distinguish it
// from another walk-in order in progress at the same time.
router.get('/', (req, res) => {
  // Plain alphabetical ORDER BY name puts "Customer 10" before "Customer 2"
  // (text sort, not numeric). Ordering by length first keeps same-length
  // names in their usual alpha/numeric order while pushing longer numbers
  // (10, 11, ...) after all the shorter ones they'd otherwise be sorted into
  // the middle of.
  const slots = db.prepare('SELECT * FROM register_slots WHERE active = 1 ORDER BY LENGTH(name), name').all();
  const openSales = db.prepare(`
    SELECT s.id, s.register_slot_id, s.total, s.created_at, s.shift_id,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0) as item_count
    FROM sales s WHERE s.order_status = 'open' AND s.register_slot_id IS NOT NULL
  `).all();
  const bySlot = {};
  for (const s of openSales) bySlot[s.register_slot_id] = s;

  res.json(slots.map((t) => ({ ...t, open_sale: bySlot[t.id] || null })));
});

router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO register_slots (name) VALUES (?)').run(name);
    res.json(db.prepare('SELECT * FROM register_slots WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM register_slots WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer slot not found' });
  const { name, active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (active !== undefined) updates.active = active ? 1 : 0;
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (setClause) {
    try {
      db.prepare(`UPDATE register_slots SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  res.json(db.prepare('SELECT * FROM register_slots WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const openSale = db.prepare(`SELECT id FROM sales WHERE register_slot_id = ? AND order_status = 'open'`).get(req.params.id);
  if (openSale) return res.status(400).json({ error: 'This slot has an open order. Charge it out first.' });
  db.prepare('UPDATE register_slots SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
