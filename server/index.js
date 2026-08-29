require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const app = express();
const PORT = process.env.PORT || 4000;

// Raised from Express's 100kb default so a base64 receipt logo (settings) fits.
app.use(express.json({ limit: '5mb' }));
app.use(
  cookieSession({
    name: 'pos_session',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    maxAge: 12 * 60 * 60 * 1000,
  })
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/registers', require('./routes/registers'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/users', require('./routes/users'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/archive', require('./routes/archive'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nClear Path POS is running at ${url}`);
  console.log('Default logins -> Admin: 826497  |  Manager 1: 000000 / Manager 2: 000001  |  Cashier 1: 123456 / Cashier 2: 567890  |  Waiter 1: 098765 / Waiter 2: 987654 / Waiter 3: 876543 / Waiter 4: 765432');
  console.log('(Manager 2, Cashier 2, and Waiter 2-4 start inactive — activate them in Staff before use.)\n');
  if (process.env.NO_OPEN !== 'true') {
    try {
      require('open')(url);
    } catch (e) {
      // Non-fatal: user can open the URL manually.
    }
  }
});
