const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});

router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.json({ id: info.lastInsertRowid, name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
