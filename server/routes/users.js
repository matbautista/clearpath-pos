const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');

const ROLES = ['admin', 'manager', 'cashier', 'waiter'];

const router = express.Router();
// Admin has full access; Manager can view the roster and activate/deactivate
// staff but can't add, remove, or edit anyone (enforced per-route below).
router.use(requireAuth, requireRole('admin', 'manager'));

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT id, name, role, active, is_default, created_at FROM users ORDER BY name').all());
});

// Cashiers' time on the clock already shows up in Cash Drawer's Shift
// History — this is the equivalent record for admin/manager/waiter, who
// never open one.
router.get('/login-history', (req, res) => {
  const rows = db.prepare(`
    SELECT ll.id, ll.user_id, ll.role, ll.logged_in_at, u.name as user_name
    FROM login_log ll JOIN users u ON u.id = ll.user_id
    ORDER BY ll.id DESC LIMIT 100
  `).all();
  res.json(rows);
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !pin || !role) return res.status(400).json({ error: 'name, pin, and role are required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-8 digits' });
  const info = db.prepare('INSERT INTO users (name, pin_hash, role) VALUES (?, ?, ?)').run(name, bcrypt.hashSync(String(pin), 10), role);
  res.json(db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  const { name, role, active, pin } = req.body;

  // Manager can only toggle active — not name, role, or PIN. Reject the
  // whole request rather than silently applying a partial edit.
  if (req.session.role === 'manager' && (name !== undefined || role !== undefined || pin !== undefined)) {
    return res.status(403).json({ error: 'Managers can only activate or deactivate staff' });
  }

  // The default Admin/Manager/Cashier/Waiter accounts are what guarantee at
  // least one login exists for each role — letting their role be reassigned
  // could leave the store with no cashier (or no manager, or no admin)
  // account at all. Name and PIN can still change; only the role is locked.
  if (existing.is_default && role !== undefined && role !== existing.role) {
    return res.status(400).json({ error: `${existing.name} is a default account — its role can't be changed.` });
  }
  // Same guarantee for deactivation — the Staff UI already hides the
  // Deactivate button for default accounts (and DELETE, this route's older
  // deactivate path, already checks this), but PUT is what the UI actually
  // calls to toggle `active` now, so it needs the same guard directly.
  if (existing.is_default && active !== undefined && !active) {
    return res.status(400).json({ error: `${existing.name} is a default account and cannot be deactivated.` });
  }

  // Whether this edit would take the store's last active admin off of the
  // admin role — by demotion or deactivation — leaving nobody who can manage
  // staff or approve the sent-to-kitchen edit/void PIN prompt.
  const losesAdminStatus = existing.role === 'admin' && existing.active === 1
    && ((role !== undefined && role !== 'admin') || (active !== undefined && !active));
  if (losesAdminStatus) {
    const otherActiveAdmins = db.prepare(
      "SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?"
    ).get(existing.id).c;
    if (otherActiveAdmins === 0) {
      return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin.' });
    }
  }

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    updates.role = role;
  }
  if (active !== undefined) updates.active = active ? 1 : 0;
  if (pin) {
    if (!/^\d{4,8}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    updates.pin_hash = bcrypt.hashSync(String(pin), 10);
  }
  const setClause = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
  if (setClause) db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.params.id });
  res.json(db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot deactivate your own account' });
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (existing.is_default) {
    return res.status(400).json({ error: `${existing.name} is a default account and cannot be deactivated.` });
  }
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
