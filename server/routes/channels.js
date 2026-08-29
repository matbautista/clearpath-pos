const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { active } = req.query;
  if (active === 'true') {
    return res.json(db.prepare('SELECT * FROM channels WHERE active = 1 ORDER BY name').all());
  }
  res.json(db.prepare('SELECT * FROM channels ORDER BY name').all());
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, commission_rate } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare('INSERT INTO channels (name, commission_rate) VALUES (?, ?)').run(name, Number(commission_rate) || 0);
    res.json(db.prepare('SELECT * FROM channels WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Channel not found' });
  const fields = ['name', 'commission_rate', 'active'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    updates[f] = f === 'active' ? (req.body[f] ? 1 : 0) : req.body[f];
  }
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (!setClause) return res.json(existing);
  try {
    db.prepare(`UPDATE channels SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
    res.json(db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  // Checks sales_archive too — a channel whose sales have all aged into the
  // archive still has real revenue history; deleting it would silently drop
  // that history from the Channels report (nothing left to join against).
  const inUse = db.prepare(`
    SELECT (SELECT COUNT(*) FROM sales WHERE channel_id = ?) + (SELECT COUNT(*) FROM sales_archive WHERE channel_id = ?) as c
  `).get(req.params.id, req.params.id).c;
  if (inUse > 0) return res.status(400).json({ error: 'This channel has sales recorded against it — deactivate it instead of deleting.' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
