const NAV_ITEMS = [
  { key: 'pos', label: 'Register', icon: '🛒', roles: ['admin', 'manager', 'cashier', 'waiter'] },
  { key: 'tables', label: 'Tables', icon: '🍽️', roles: ['admin', 'manager', 'cashier', 'waiter'] },
  { key: 'inventory', label: 'Inventory', icon: '📦', roles: ['admin', 'manager'] },
  { key: 'customers', label: 'Customers', icon: '👥', roles: ['admin', 'manager', 'waiter'] },
  { key: 'reports', label: 'Reports', icon: '📊', roles: ['admin', 'manager'] },
  { key: 'shift', label: 'Cash Drawer', icon: '🗄️', roles: ['admin', 'manager', 'cashier'] },
  { key: 'users', label: 'Staff', icon: '🔑', roles: ['admin', 'manager'] },
  { key: 'settings', label: 'Settings', icon: '⚙️', roles: ['admin'] },
];

const VIEWS = {
  pos: renderPosView,
  tables: renderTablesView,
  inventory: renderInventoryView,
  customers: renderCustomersView,
  reports: renderReportsView,
  shift: renderShiftView,
  users: renderUsersView,
  settings: renderSettingsView,
};

async function boot() {
  ensureGlobalEmbers();
  try {
    const me = await api.get('/api/auth/me');
    window.APP_STATE.user = me;
    await loadSettings();
    renderShell();
  } catch (e) {
    renderLoginView();
  }
}

async function loadSettings() {
  window.APP_STATE.settings = await api.get('/api/settings');
}

function navigate(route) {
  window.APP_STATE.route = route;
  renderShell();
}

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const { user } = window.APP_STATE;

  const allowedKeys = NAV_ITEMS.filter((n) => n.roles.includes(user.role)).map((n) => n.key);
  if (!allowedKeys.includes(window.APP_STATE.route)) {
    window.APP_STATE.route = 'pos';
  }
  const route = window.APP_STATE.route;

  const sidebar = el('div', { class: 'sidebar' }, [
    el('div', { class: 'brand' }, [
      el('img', { src: '/assets/logo.png', alt: '' }),
      el('span', {}, 'Sugbahan'),
    ]),
    ...NAV_ITEMS.filter((n) => n.roles.includes(user.role)).map((n) =>
      el('button', {
        class: `nav-item ${route === n.key ? 'active' : ''}`,
        onclick: () => navigate(n.key),
      }, [`${n.icon}  ${n.label}`])
    ),
    el('div', { class: 'sidebar-footer' }, [
      el('div', { class: 'user-chip' }, [
        el('div', {}, [
          el('div', { class: 'name' }, user.name),
          el('div', { class: 'role' }, user.role),
        ]),
      ]),
      el('button', { class: 'logout-btn', onclick: logout }, 'Log out'),
    ]),
  ]);

  const main = el('div', { class: 'main', id: 'main-view' });
  app.appendChild(el('div', { class: 'shell' }, [sidebar, main]));

  const renderFn = VIEWS[route] || renderPosView;
  renderFn(main);
}

async function logout() {
  await api.post('/api/auth/logout');
  window.APP_STATE.user = null;
  renderLoginView();
}

document.addEventListener('DOMContentLoaded', boot);
