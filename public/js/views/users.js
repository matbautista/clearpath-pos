async function renderUsersView(container) {
  container.innerHTML = '';
  let users = [];
  // Admin has full access. Manager can view the roster and activate/
  // deactivate staff, but can't add, remove, or edit anyone.
  const isAdmin = window.APP_STATE.user.role === 'admin';

  async function load() { users = await api.get('/api/users'); }
  await load();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Staff Accounts'),
    isAdmin ? el('button', { class: 'btn primary', onclick: () => openUserModal(null, rerender) }, '+ Add Staff') : null,
  ].filter(Boolean));

  const tableWrap = el('div', { class: 'card' });

  function renderTable() {
    tableWrap.innerHTML = '';
    const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Name', 'Role', 'Status', ''].map((h) => el('th', {}, h))))]);
    const tbody = el('tbody');
    users.forEach((u) => {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [u.name, u.is_default ? el('span', { class: 'tag', style: 'margin-left:6px;' }, 'Default') : null].filter(Boolean)),
        el('td', {}, el('span', { class: 'tag' }, u.role)),
        el('td', {}, u.active ? 'Active' : 'Deactivated'),
        el('td', {}, [
          isAdmin ? el('button', { class: 'btn small', onclick: () => openUserModal(u, rerender) }, 'Edit') : null,
          isAdmin ? ' ' : null,
          !u.is_default ? el('button', { class: `btn small ${u.active ? 'danger' : 'success'}`, onclick: async () => {
            try { await api.put(`/api/users/${u.id}`, { active: !u.active }); rerender(); } catch (e) { toast(e.message, 'error'); }
          } }, u.active ? 'Deactivate' : 'Activate') : null,
        ].filter(Boolean)),
      ]));
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  async function rerender() { await load(); renderTable(); }
  renderTable();

  container.appendChild(header);
  container.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px;margin-top:-8px;' }, 'Cashiers can use Register, Tables, and their own Cash Drawer (a shift is required). Waiters can take orders on Register/Tables but can\'t charge, and manage Customers. Managers can view Register/Tables/Cash Drawer, and fully manage Inventory, Customers, and Reports (including refunds/voids); they can activate or deactivate staff but not add, remove, or edit them. Admins have full access to Inventory, Staff, and Settings, and view-only access elsewhere. The default account for each role is protected — it can\'t be deactivated or have its role changed (name and PIN can still be edited by an admin).'));
  container.appendChild(tableWrap);

  const historyWrap = el('div', { class: 'card', style: 'margin-top:20px;' }, [el('h3', { style: 'margin-top:0;' }, 'Login History')]);
  container.appendChild(historyWrap);
  await renderLoginHistory(historyWrap);
}

// Cashiers' time on the clock already shows up in Cash Drawer's Shift
// History (opened_at/closed_at) — this is the equivalent record for admin,
// manager, and waiter, who never open one.
async function renderLoginHistory(historyWrap) {
  const history = await api.get('/api/users/login-history');
  if (history.length === 0) {
    historyWrap.appendChild(el('div', { class: 'empty-state' }, 'No logins recorded yet.'));
    return;
  }
  const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Name', 'Role', 'Logged In At'].map((h) => el('th', {}, h))))]);
  const tbody = el('tbody');
  history.forEach((h) => {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, h.user_name),
      el('td', {}, el('span', { class: 'tag' }, h.role)),
      el('td', {}, new Date(h.logged_in_at).toLocaleString()),
    ]));
  });
  table.appendChild(tbody);
  historyWrap.appendChild(table);
}

function openUserModal(user, onDone) {
  const isEdit = Boolean(user);
  const nameInput = el('input', { type: 'text', value: user ? user.name : '' });
  const pinInput = el('input', { type: 'text', placeholder: isEdit ? 'Leave blank to keep current PIN' : '4-8 digit PIN', maxlength: '8' });
  const roleLocked = Boolean(user && user.is_default);
  const roleSelect = el('select', { disabled: roleLocked ? 'true' : null }, ['cashier', 'waiter', 'manager', 'admin'].map((r) => el('option', { value: r, selected: user && user.role === r ? 'true' : null }, r)));
  const errorEl = el('div', { class: 'login-error' }, '');
  const backdrop = el('div', { class: 'modal-backdrop' });

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, isEdit ? 'Edit Staff' : 'Add Staff'),
    el('div', { class: 'field' }, [el('label', {}, 'Name'), nameInput]),
    el('div', { class: 'field' }, [
      el('label', {}, 'Role'),
      roleSelect,
      roleLocked ? el('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px;' }, 'This is a default account — its role can\'t be changed.') : null,
    ].filter(Boolean)),
    el('div', { class: 'field' }, [el('label', {}, 'PIN'), pinInput]),
    errorEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!nameInput.value.trim()) { errorEl.textContent = 'Name is required'; return; }
        try {
          if (isEdit) {
            const payload = { name: nameInput.value.trim(), role: roleSelect.value };
            if (pinInput.value) payload.pin = pinInput.value;
            await api.put(`/api/users/${user.id}`, payload);
          } else {
            if (!pinInput.value) { errorEl.textContent = 'PIN is required'; return; }
            await api.post('/api/users', { name: nameInput.value.trim(), role: roleSelect.value, pin: pinInput.value });
          }
          document.body.removeChild(backdrop);
          onDone();
        } catch (e) { errorEl.textContent = e.message; }
      } }, isEdit ? 'Save' : 'Add'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
