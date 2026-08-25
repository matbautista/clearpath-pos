const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

router.put('/', requireRole('admin', 'manager'), (req, res) => {
  // default_tax_rate is a fraction (0.12 = 12%) that now seeds every new
  // product's tax rate — a value typed as a whole-number percent (e.g. "12")
  // would silently give every future product a 1200% tax rate.
  if (req.body.default_tax_rate !== undefined) {
    const n = Number(req.body.default_tax_rate);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return res.status(400).json({ error: 'Default Tax Rate must be a fraction between 0 and 1 (e.g. 0.12 for 12%)' });
    }
  }
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) upsert.run({ key, value: String(value) });
  });
  tx(Object.entries(req.body));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

module.exports = router;
