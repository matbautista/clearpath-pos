async function renderUsersView(container) {
  container.innerHTML = '';
  let users = [];

  async function load() { users = await api.get('/api/users'); }
  await load();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Staff Accounts'),
    el('button', { class: 'btn primary', onclick: () => openUserModal(null, rerender) }, '+ Add Staff'),
  ]);

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
          el('button', { class: 'btn small', onclick: () => openUserModal(u, rerender) }, 'Edit'),
          ' ',
          (u.active && !u.is_default) ? el('button', { class: 'btn small danger', onclick: async () => {
            try { await api.del(`/api/users/${u.id}`); rerender(); } catch (e) { toast(e.message, 'error'); }
          } }, 'Deactivate') : null,
        ].filter(Boolean)),
      ]));
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  async function rerender() { await load(); renderTable(); }
  renderTable();

  container.appendChild(header);
  container.appendChild(el('p', { style: 'color:var(--text-muted);font-size:13px;margin-top:-8px;' }, 'Cashiers can use Register, Tables, and their own Cash Drawer. Managers can also manage Inventory, Customers, Reports, refunds, and Settings. Admins have full access, including staff accounts. The default Admin, Manager, and Cashier accounts are protected — they can\'t be deactivated or have their role changed (name and PIN can still be edited).'));
  container.appendChild(tableWrap);
}

function openUserModal(user, onDone) {
  const isEdit = Boolean(user);
  const nameInput = el('input', { type: 'text', value: user ? user.name : '' });
  const pinInput = el('input', { type: 'text', placeholder: isEdit ? 'Leave blank to keep current PIN' : '4-8 digit PIN', maxlength: '8' });
  const roleLocked = Boolean(user && user.is_default);
  const roleSelect = el('select', { disabled: roleLocked ? 'true' : null }, ['cashier', 'manager', 'admin'].map((r) => el('option', { value: r, selected: user && user.role === r ? 'true' : null }, r)));
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
