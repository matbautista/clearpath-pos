const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// Lists all active tables along with a summary of their current open order
// (if any), so the Tables view can show Available vs Occupied at a glance.
router.get('/', (req, res) => {
  // Same length-then-name ordering as registers.js — plain alphabetical
  // ORDER BY name would put "Table 10" before "Table 2".
  const tables = db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY LENGTH(name), name').all();
  const openSales = db.prepare(`
    SELECT s.id, s.table_id, s.total, s.created_at, s.shift_id,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.voided = 0) as item_count
    FROM sales s WHERE s.order_status = 'open' AND s.table_id IS NOT NULL
  `).all();
  const byTable = {};
  for (const s of openSales) byTable[s.table_id] = s;

  res.json(tables.map((t) => ({ ...t, open_sale: byTable[t.id] || null })));
});

router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO tables (name) VALUES (?)').run(name);
    res.json(db.prepare('SELECT * FROM tables WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Table not found' });
  const { name, active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (active !== undefined) updates.active = active ? 1 : 0;
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (setClause) {
    try {
      db.prepare(`UPDATE tables SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  res.json(db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  const openSale = db.prepare(`SELECT id FROM sales WHERE table_id = ? AND order_status = 'open'`).get(req.params.id);
  if (openSale) return res.status(400).json({ error: 'This table has an open order. Bill it out first.' });
  db.prepare('UPDATE tables SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
