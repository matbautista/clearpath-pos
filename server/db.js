const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'pos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','cashier')),
  active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL NOT NULL DEFAULT 5,
  track_stock INTEGER NOT NULL DEFAULT 1,
  color TEXT DEFAULT '#4f7cff',
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  loyalty_points REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opening_cash REAL NOT NULL DEFAULT 0,
  closing_cash REAL,
  expected_cash REAL,
  cash_diff REAL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  shift_id INTEGER REFERENCES shifts(id),
  channel_id INTEGER REFERENCES channels(id),
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  vat_exempt_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','refunded','partially_refunded')),
  order_status TEXT NOT NULL DEFAULT 'billed' CHECK (order_status IN ('open','billed')),
  table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','senior','pwd')),
  discount_id_number TEXT,
  discount_holder_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  billed_at TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  vat_exempt_amount REAL NOT NULL DEFAULT 0,
  sc_pwd_eligible INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  sent_to_kitchen INTEGER NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  refunded_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('cash','card','gcash','maya','other')),
  amount REAL NOT NULL,
  tendered REAL,
  change_given REAL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_sale_id INTEGER NOT NULL REFERENCES sales(id),
  refund_sale_number TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refund_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  qty REAL NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  change_qty REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('sale','refund','restock','adjustment','void')),
  reference TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Yearly archive: rows moved here (never deleted) once a calendar year ages
-- out of the "hot" window, so the live sales/* tables stay small while every
-- record remains queryable. See server/routes/archive.js.
CREATE TABLE IF NOT EXISTS sales_archive (
  id INTEGER PRIMARY KEY,
  sale_number TEXT NOT NULL,
  user_id INTEGER,
  customer_id INTEGER,
  shift_id INTEGER,
  channel_id INTEGER,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  vat_exempt_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  order_status TEXT NOT NULL,
  table_id INTEGER,
  discount_type TEXT NOT NULL DEFAULT 'none',
  discount_id_number TEXT,
  discount_holder_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  billed_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_items_archive (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL,
  product_id INTEGER,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  vat_exempt_amount REAL NOT NULL DEFAULT 0,
  sc_pwd_eligible INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  sent_to_kitchen INTEGER NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  refunded_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments_archive (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  tendered REAL,
  change_given REAL,
  reference TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds_archive (
  id INTEGER PRIMARY KEY,
  original_sale_id INTEGER NOT NULL,
  refund_sale_number TEXT,
  user_id INTEGER,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refund_items_archive (
  id INTEGER PRIMARY KEY,
  refund_id INTEGER NOT NULL,
  sale_item_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  amount REAL NOT NULL
);

-- One row per calendar year that has been archived — the manifest that
-- drives eligibility checks (idempotency) and links each year to its
-- on-disk JSON export.
CREATE TABLE IF NOT EXISTS archive_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL UNIQUE,
  sale_count INTEGER NOT NULL DEFAULT 0,
  sale_item_count INTEGER NOT NULL DEFAULT 0,
  payment_count INTEGER NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  refund_item_count INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_sales_archive_created ON sales_archive(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_archive_billed ON sales_archive(billed_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_archive_sale ON sale_items_archive(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_archive_sale ON payments_archive(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_billed ON sales(billed_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_table ON sales(table_id);
`);

function migrate() {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('is_default')) {
    db.exec('ALTER TABLE users ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
    // Backfill: the original seeded Admin/Cashier accounts predate this
    // column — mark them default so existing installs get the same
    // can't-delete protection a fresh install gets from seed().
    db.exec(`UPDATE users SET is_default = 1 WHERE (name = 'Admin' AND role = 'admin') OR (name = 'Cashier' AND role = 'cashier')`);
  }

  const salesCols = db.prepare("PRAGMA table_info(sales)").all().map((c) => c.name);
  if (!salesCols.includes('vat_exempt_total')) db.exec('ALTER TABLE sales ADD COLUMN vat_exempt_total REAL NOT NULL DEFAULT 0');
  if (!salesCols.includes('discount_type')) db.exec("ALTER TABLE sales ADD COLUMN discount_type TEXT NOT NULL DEFAULT 'none'");
  if (!salesCols.includes('discount_id_number')) db.exec('ALTER TABLE sales ADD COLUMN discount_id_number TEXT');
  if (!salesCols.includes('discount_holder_name')) db.exec('ALTER TABLE sales ADD COLUMN discount_holder_name TEXT');
  if (!salesCols.includes('order_status')) db.exec("ALTER TABLE sales ADD COLUMN order_status TEXT NOT NULL DEFAULT 'billed'");
  if (!salesCols.includes('table_id')) db.exec('ALTER TABLE sales ADD COLUMN table_id INTEGER');
  if (!salesCols.includes('channel_id')) db.exec('ALTER TABLE sales ADD COLUMN channel_id INTEGER');
  if (!salesCols.includes('customer_id')) db.exec('ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');
  if (!salesCols.includes('billed_at')) {
    db.exec('ALTER TABLE sales ADD COLUMN billed_at TEXT');
    db.exec("UPDATE sales SET billed_at = created_at WHERE order_status = 'billed'");
  }

  const salesArchiveCols = db.prepare("PRAGMA table_info(sales_archive)").all().map((c) => c.name);
  if (!salesArchiveCols.includes('channel_id')) db.exec('ALTER TABLE sales_archive ADD COLUMN channel_id INTEGER');

  const productCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
  if (!productCols.includes('image_url')) db.exec('ALTER TABLE products ADD COLUMN image_url TEXT');

  const itemCols = db.prepare("PRAGMA table_info(sale_items)").all().map((c) => c.name);
  if (!itemCols.includes('vat_exempt_amount')) db.exec('ALTER TABLE sale_items ADD COLUMN vat_exempt_amount REAL NOT NULL DEFAULT 0');
  if (!itemCols.includes('sc_pwd_eligible')) db.exec('ALTER TABLE sale_items ADD COLUMN sc_pwd_eligible INTEGER NOT NULL DEFAULT 0');
  if (!itemCols.includes('notes')) db.exec('ALTER TABLE sale_items ADD COLUMN notes TEXT');
  if (!itemCols.includes('sent_to_kitchen')) db.exec('ALTER TABLE sale_items ADD COLUMN sent_to_kitchen INTEGER NOT NULL DEFAULT 0');

  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_table ON sales(table_id)');
}
migrate();

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (name, pin_hash, role, is_default) VALUES (?, ?, ?, 1)'
    );
    insertUser.run('Admin', bcrypt.hashSync('1234', 10), 'admin');
    insertUser.run('Cashier', bcrypt.hashSync('0000', 10), 'cashier');
  }

  const tableCount = db.prepare('SELECT COUNT(*) c FROM tables').get().c;
  if (tableCount === 0) {
    const insertTable = db.prepare('INSERT INTO tables (name) VALUES (?)');
    for (let i = 1; i <= 6; i++) insertTable.run(`Table ${i}`);
  }

  // Order channels: where a sale actually came from (in-house vs. a delivery
  // marketplace). commission_rate is what that platform keeps, used to show
  // net (after-commission) revenue per channel in Reports.
  const channelCount = db.prepare('SELECT COUNT(*) c FROM channels').get().c;
  if (channelCount === 0) {
    const insertChannel = db.prepare('INSERT INTO channels (name, commission_rate) VALUES (?, ?)');
    insertChannel.run('Walk-in', 0);
    insertChannel.run('FoodPanda', 0.2);
    insertChannel.run('GrabFood', 0.2);
  }
  // Existing sales predate this feature — attribute them to Walk-in rather
  // than leaving channel_id null, so channel reports account for every sale.
  const walkInId = db.prepare("SELECT id FROM channels WHERE name = 'Walk-in'").get()?.id;
  if (walkInId) db.prepare('UPDATE sales SET channel_id = ? WHERE channel_id IS NULL').run(walkInId);

  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
    const cats = ['Chicken Inasal', 'Kansi & Sinigang', 'Grilled Favorites', 'Rice Options', 'Solo Meals'];
    for (const c of cats) insertCat.run(c);
  }

  const prodCount = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (prodCount === 0) {
    const cat = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
    const insertProd = db.prepare(`
      INSERT INTO products (sku, name, category_id, price, tax_rate, track_stock, color, image_url)
      VALUES (@sku, @name, @category_id, @price, @tax_rate, 0, @color, @image_url)
    `);
    // Sugbahan's menu — made-to-order dishes, so stock isn't tracked per item
    // (track_stock: false) the way packaged retail goods would be.
    const inasal = cat('Chicken Inasal');
    const kansiSinigang = cat('Kansi & Sinigang');
    const grilled = cat('Grilled Favorites');
    const rice = cat('Rice Options');
    const solo = cat('Solo Meals');
    const img = (file) => `/assets/menu/${file}`;
    const menu = [
      // Chicken Inasal
      { sku: 'INA-PEC-RICE', name: 'Pecho with Rice', category_id: inasal, price: 199, tax_rate: 0.12, color: '#f2541f', image_url: img('pecho.jpg') },
      { sku: 'INA-PAA-RICE', name: 'Pa-a with Rice', category_id: inasal, price: 180, tax_rate: 0.12, color: '#f2541f', image_url: img('paa-with-rice.jpg') },
      { sku: 'INA-PAK-RICE', name: 'Pakpak (2x) with Rice', category_id: inasal, price: 170, tax_rate: 0.12, color: '#f2541f', image_url: img('pakpak-with-rice.jpg') },
      { sku: 'INA-PEC-AC', name: 'Pecho Ala-carte', category_id: inasal, price: 170, tax_rate: 0.12, color: '#f2541f', image_url: img('pecho-ala-carte.jpg') },
      { sku: 'INA-PAA-AC', name: 'Pa-a Ala-carte', category_id: inasal, price: 150, tax_rate: 0.12, color: '#f2541f', image_url: img('paa-ala-carte.jpg') },
      { sku: 'INA-PAK-AC', name: 'Pakpak (2x) Ala-carte', category_id: inasal, price: 140, tax_rate: 0.12, color: '#f2541f', image_url: img('pakpak-ala-carte.jpg') },
      // Kansi & Sinigang (good for 2 pax)
      { sku: 'KS-BEEF', name: 'Kansi Beef (2 Pax)', category_id: kansiSinigang, price: 340, tax_rate: 0.12, color: '#d81920', image_url: img('kansi-beef.jpg') },
      { sku: 'KS-PATA', name: 'Kansi Pata (2 Pax)', category_id: kansiSinigang, price: 260, tax_rate: 0.12, color: '#d81920', image_url: img('kansi-pata.jpg') },
      { sku: 'KS-HIPON', name: 'Sinigang na Hipon (2 Pax)', category_id: kansiSinigang, price: 340, tax_rate: 0.12, color: '#d81920', image_url: img('sinigang-hipon.jpg') },
      { sku: 'KS-BABOY', name: 'Sinigang na Baboy (2 Pax)', category_id: kansiSinigang, price: 270, tax_rate: 0.12, color: '#d81920', image_url: img('sinigang-baboy.jpg') },
      { sku: 'KS-BANGUS', name: 'Sinigang na Bangus (2 Pax)', category_id: kansiSinigang, price: 230, tax_rate: 0.12, color: '#d81920', image_url: img('sinigang-bangus.jpg') },
      { sku: 'KS-BULALO', name: 'Bulalo (2 Pax)', category_id: kansiSinigang, price: 360, tax_rate: 0.12, color: '#d81920', image_url: img('bulalo.jpg') },
      // Grilled Favorites
      { sku: 'GRL-BANGUS-W', name: 'Grilled Bangus (Whole) w/ Rice', category_id: grilled, price: 220, tax_rate: 0.12, color: '#b45309', image_url: img('bangus-whole-rice.jpg') },
      { sku: 'GRL-BANGUS-H', name: 'Grilled Bangus (Half) w/ Rice', category_id: grilled, price: 110, tax_rate: 0.12, color: '#b45309', image_url: img('bangus-half-rice.jpg') },
      { sku: 'GRL-TILAPIA-R', name: 'Grilled Tilapia w/ Rice', category_id: grilled, price: 150, tax_rate: 0.12, color: '#b45309', image_url: img('tilapia-with-rice.jpg') },
      { sku: 'GRL-LIEMPO-R', name: 'Grilled Liempo w/ Rice', category_id: grilled, price: 155, tax_rate: 0.12, color: '#b45309', image_url: img('liempo.jpg') },
      { sku: 'GRL-BANGUS-AC', name: 'Grilled Bangus Ala-carte', category_id: grilled, price: 190, tax_rate: 0.12, color: '#b45309', image_url: img('bangus-ala-carte.jpg') },
      { sku: 'GRL-TILAPIA-AC', name: 'Grilled Tilapia Ala-carte', category_id: grilled, price: 120, tax_rate: 0.12, color: '#b45309', image_url: img('tilapia-ala-carte.jpg') },
      { sku: 'GRL-LIEMPO-AC', name: 'Grilled Liempo Ala-carte', category_id: grilled, price: 125, tax_rate: 0.12, color: '#b45309', image_url: img('liempo.jpg') },
      // Rice Options
      { sku: 'RIC-PLAIN', name: 'Plain Rice', category_id: rice, price: 29, tax_rate: 0.12, color: '#8b5e34', image_url: img('plain-rice.jpg') },
      { sku: 'RIC-JAVA', name: 'Java Rice', category_id: rice, price: 40, tax_rate: 0.12, color: '#8b5e34', image_url: img('java-rice.jpg') },
      { sku: 'RIC-GARLIC', name: 'Garlic Rice', category_id: rice, price: 40, tax_rate: 0.12, color: '#8b5e34', image_url: img('garlic-rice.jpg') },
      // Solo Meals
      { sku: 'SOLO-BEEF', name: 'Kansi Beef (Solo)', category_id: solo, price: 199, tax_rate: 0.12, color: '#7c2d12', image_url: img('kansi-beef.jpg') },
      { sku: 'SOLO-PATA', name: 'Kansi Pata (Solo)', category_id: solo, price: 160, tax_rate: 0.12, color: '#7c2d12', image_url: img('kansi-pata.jpg') },
      { sku: 'SOLO-BULALO', name: 'Bulalo (Solo)', category_id: solo, price: 199, tax_rate: 0.12, color: '#7c2d12', image_url: img('bulalo.jpg') },
      { sku: 'SOLO-HIPON', name: 'Sinigang na Hipon (Solo)', category_id: solo, price: 199, tax_rate: 0.12, color: '#7c2d12', image_url: img('sinigang-hipon.jpg') },
      { sku: 'SOLO-BABOY', name: 'Sinigang na Baboy (Solo)', category_id: solo, price: 165, tax_rate: 0.12, color: '#7c2d12', image_url: img('sinigang-baboy.jpg') },
      { sku: 'SOLO-BANGUS', name: 'Sinigang na Bangus (Solo)', category_id: solo, price: 145, tax_rate: 0.12, color: '#7c2d12', image_url: img('sinigang-bangus.jpg') },
    ];
    for (const p of menu) insertProd.run(p);
  }

  let defaultLogoDataUri = '';
  try {
    const logoBuffer = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'logo.png'));
    defaultLogoDataUri = `data:image/png;base64,${logoBuffer.toString('base64')}`;
  } catch (e) {
    // Logo asset not present on disk — settings just start with no logo.
  }

  const settingsDefaults = {
    store_name: 'Sugbahan',
    store_address: '',
    store_phone: '',
    store_tin: '',
    store_logo: defaultLogoDataUri,
    receipt_footer: 'Salamat! Taste the difference.',
    default_tax_rate: '0.12',
    currency_symbol: '₱',
    receipt_paper_width: '58mm',
    thermal_printer_enabled: 'false',
    thermal_printer_target: '',
    kitchen_printer_enabled: 'false',
    kitchen_printer_target: '',
  };
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(settingsDefaults)) {
    if (!getSetting.get(k)) insertSetting.run(k, v);
  }
}

seed();

module.exports = db;
