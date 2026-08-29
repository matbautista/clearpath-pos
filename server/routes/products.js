const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// tax_rate is a fraction (0.12 = 12%), not a percentage — the "0.12 = 12%"
// label invites someone to type "12" by mistake, which would silently apply
// a 1200% tax to every sale of that product.
function isValidTaxRate(tax_rate) {
  const n = Number(tax_rate);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

router.get('/', (req, res) => {
  const { q, category_id, active, channel_id } = req.query;
  // channel_id swaps in that channel's price override (e.g. FoodPanda/GrabFood
  // menu prices, marked up to absorb the platform's commission) wherever one
  // exists, and reports whether the item is offered on that channel at all —
  // products.price stays the reported "price" field either way, so callers
  // that don't care about channels don't need to change.
  let sql = `SELECT p.*, c.name as category_name${channel_id ? ', COALESCE(cp.price, p.price) as price, COALESCE(cp.available, 1) as channel_available' : ''} FROM products p
             LEFT JOIN categories c ON c.id = p.category_id`;
  const params = [];
  if (channel_id) {
    sql += ` LEFT JOIN product_channel_prices cp ON cp.product_id = p.id AND cp.channel_id = ?`;
    params.push(channel_id);
  }
  sql += ` WHERE 1=1`;
  if (q) {
    sql += ` AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category_id) {
    sql += ` AND p.category_id = ?`;
    params.push(category_id);
  }
  if (active !== undefined) {
    sql += ` AND p.active = ?`;
    params.push(active === 'true' ? 1 : 0);
  }
  sql += ` ORDER BY p.name`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id/channel-prices', (req, res) => {
  res.json(db.prepare('SELECT channel_id, price, available FROM product_channel_prices WHERE product_id = ?').all(req.params.id));
});

router.put('/:id/channel-prices/:channelId', requireRole('admin', 'manager'), (req, res) => {
  const { price, available } = req.body;
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const hasPrice = !(price === null || price === undefined || price === '');
  const n = hasPrice ? Number(price) : null;
  if (hasPrice && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: 'Price must be a non-negative number' });
  const avail = available === undefined ? 1 : (available ? 1 : 0);
  db.prepare(`
    INSERT INTO product_channel_prices (product_id, channel_id, price, available) VALUES (?, ?, ?, ?)
    ON CONFLICT(product_id, channel_id) DO UPDATE SET price = excluded.price, available = excluded.available
  `).run(req.params.id, req.params.channelId, n, avail);
  res.json({ ok: true, price: n, available: Boolean(avail) });
});

router.get('/low-stock', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM products
    WHERE track_stock = 1 AND active = 1 AND stock_qty <= low_stock_threshold
    ORDER BY stock_qty ASC
  `).all();
  res.json(rows);
});

router.get('/barcode/:code', (req, res) => {
  const { channel_id } = req.query;
  // Same channel price-override join as GET / — without it, scanning a
  // barcode for a product not already in the client's cached product list
  // (e.g. added after the screen loaded) would add it at its walk-in price
  // and ignore per-channel availability.
  let sql = `SELECT p.*${channel_id ? ', COALESCE(cp.price, p.price) as price, COALESCE(cp.available, 1) as channel_available' : ''} FROM products p`;
  const params = [];
  if (channel_id) {
    sql += ` LEFT JOIN product_channel_prices cp ON cp.product_id = p.id AND cp.channel_id = ?`;
    params.push(channel_id);
  }
  sql += ` WHERE p.barcode = ? AND p.active = 1`;
  params.push(req.params.code);
  const product = db.prepare(sql).get(...params);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

router.get('/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

router.post('/', requireRole('admin', 'manager'), (req, res) => {
  const { sku, barcode, name, category_id, price, cost, tax_rate, stock_qty, low_stock_threshold, track_stock, color, image_url } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
  if (tax_rate !== undefined && !isValidTaxRate(tax_rate)) {
    return res.status(400).json({ error: 'Tax rate must be a fraction between 0 and 1 (e.g. 0.12 for 12%)' });
  }
  const stmt = db.prepare(`
    INSERT INTO products (sku, barcode, name, category_id, price, cost, tax_rate, stock_qty, low_stock_threshold, track_stock, color, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    const info = stmt.run(
      sku || null, barcode || null, name, category_id || null,
      Number(price), Number(cost) || 0, Number(tax_rate) || 0,
      Number(stock_qty) || 0, Number(low_stock_threshold) || 5,
      track_stock === false ? 0 : 1, color || '#4f7cff', image_url || null
    );
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireRole('admin', 'manager'), (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found' });
  if (req.body.tax_rate !== undefined && !isValidTaxRate(req.body.tax_rate)) {
    return res.status(400).json({ error: 'Tax rate must be a fraction between 0 and 1 (e.g. 0.12 for 12%)' });
  }
  const fields = ['sku', 'barcode', 'name', 'category_id', 'price', 'cost', 'tax_rate', 'stock_qty', 'low_stock_threshold', 'track_stock', 'color', 'image_url', 'active'];
  const boolFields = new Set(['track_stock', 'active']);
  const updates = {};
  for (const f of fields) {
    if (req.body[f] === undefined) continue;
    // better-sqlite3 can't bind JS booleans directly — the client sends
    // track_stock/active as true/false, so coerce to 0/1 for SQLite.
    updates[f] = boolFields.has(f) ? (req.body[f] ? 1 : 0) : req.body[f];
  }
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (!setClause) return res.json(existing);
  try {
    db.prepare(`UPDATE products SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/adjust-stock', requireRole('admin', 'manager'), (req, res) => {
  const { change_qty, reason, note } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const qty = Number(change_qty);
  if (!qty) return res.status(400).json({ error: 'change_qty is required' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(qty, product.id);
    db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason, reference, user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(product.id, qty, reason || 'adjustment', note || null, req.session.userId);
  });
  tx();
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(product.id));
});

router.delete('/:id', requireRole('admin', 'manager'), (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
