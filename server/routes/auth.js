const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.get('/staff-list', (req, res) => {
  const users = db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all();
  res.json(users);
});

router.post('/login', (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'userId and pin are required' });
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  res.json({ id: user.id, name: user.name, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.session.userId, name: req.session.name, role: req.session.role });
});

module.exports = router;
