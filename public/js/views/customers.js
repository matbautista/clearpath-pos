async function renderCustomersView(container) {
  container.innerHTML = '';
  let customers = [];
  let query = '';

  async function load() {
    customers = query ? await api.get(`/api/customers?q=${encodeURIComponent(query)}`) : await api.get('/api/customers');
  }
  await load();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Customers'),
    el('button', { class: 'btn primary', onclick: () => openCustomerModal(null, rerender) }, '+ Add Customer'),
  ]);

  const searchInput = el('input', { type: 'text', placeholder: 'Search customers…', style: 'max-width:320px;margin-bottom:14px;' });
  const tableWrap = el('div', { class: 'card' });

  searchInput.addEventListener('input', async () => { query = searchInput.value; await load(); renderTable(); });

  function renderTable() {
    tableWrap.innerHTML = '';
    if (customers.length === 0) { tableWrap.appendChild(el('div', { class: 'empty-state' }, 'No customers yet.')); return; }
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, ['Name', 'Phone', 'Email', 'Loyalty Points', ''].map((h) => el('th', {}, h)))),
    ]);
    const tbody = el('tbody');
    customers.forEach((c) => {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, c.name),
        el('td', {}, c.phone || '—'),
        el('td', {}, c.email || '—'),
        el('td', {}, String(c.loyalty_points)),
        el('td', {}, [
          el('button', { class: 'btn small', onclick: () => openCustomerHistoryModal(c) }, 'History'),
          ' ',
          el('button', { class: 'btn small', onclick: () => openCustomerModal(c, rerender) }, 'Edit'),
          ' ',
          el('button', { class: 'btn small danger', onclick: async () => {
            if (confirm(`Delete ${c.name}? Their past orders stay in Reports but will no longer show this customer's name, and they'll drop out of the Top Spenders / Recurring / Most Consistent lists.`)) {
              try {
                await api.del(`/api/customers/${c.id}`);
                rerender();
              } catch (e) { toast(e.message, 'error'); }
            }
          } }, 'Delete'),
        ]),
      ]));
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  async function rerender() { await load(); renderTable(); }
  renderTable();

  container.appendChild(header);
  container.appendChild(searchInput);
  container.appendChild(tableWrap);
}

// Shows the last 25 orders for one customer (server/routes/customers.js
// unions live + archived sales) — the only place in the app this data
// surfaces; the list/search view above never fetches a customer by id.
async function openCustomerHistoryModal(customer) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const bodyEl = el('div', { style: 'margin-top:10px;max-height:320px;overflow-y:auto;' }, el('div', { class: 'empty-state' }, 'Loading…'));

  const modal = el('div', { class: 'modal', style: 'width:480px;' }, [
    el('h3', {}, `${customer.name} — Order History`),
    el('div', { style: 'font-size:13px;color:var(--text-muted);margin-top:-6px;' }, `${customer.loyalty_points} loyalty point${customer.loyalty_points === 1 ? '' : 's'}`),
    bodyEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Close'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const full = await api.get(`/api/customers/${customer.id}`);
  bodyEl.innerHTML = '';
  if (full.purchases.length === 0) {
    bodyEl.appendChild(el('div', { class: 'empty-state' }, 'No orders yet.'));
    return;
  }
  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, ['Receipt #', 'Date', 'Total', 'Status'].map((h) => el('th', {}, h)))),
  ]);
  const tbody = el('tbody');
  full.purchases.forEach((p) => {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, p.sale_number),
      el('td', {}, p.created_at),
      el('td', {}, money(p.total)),
      el('td', {}, el('span', { class: `badge ${p.status}` }, p.status.replace('_', ' '))),
    ]));
  });
  table.appendChild(tbody);
  bodyEl.appendChild(table);
}

function openCustomerModal(customer, onDone) {
  const isEdit = Boolean(customer);
  const data = customer || { name: '', phone: '', email: '', notes: '' };
  const backdrop = el('div', { class: 'modal-backdrop' });
  const nameInput = el('input', { type: 'text', value: data.name });
  const phoneInput = el('input', { type: 'tel', value: data.phone || '' });
  const emailInput = el('input', { type: 'email', value: data.email || '' });
  const notesInput = el('textarea', { rows: '3' }, data.notes || '');
  const errorEl = el('div', { class: 'login-error' }, '');

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, isEdit ? 'Edit Customer' : 'Add Customer'),
    el('div', { class: 'field' }, [el('label', {}, 'Name'), nameInput]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Phone'), phoneInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Email'), emailInput]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Notes'), notesInput]),
    errorEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!nameInput.value.trim()) { errorEl.textContent = 'Name is required'; return; }
        const payload = { name: nameInput.value.trim(), phone: phoneInput.value.trim(), email: emailInput.value.trim(), notes: notesInput.value.trim() };
        try {
          if (isEdit) await api.put(`/api/customers/${customer.id}`, payload);
          else await api.post('/api/customers', payload);
          document.body.removeChild(backdrop);
          onDone();
        } catch (e) { errorEl.textContent = e.message; }
      } }, isEdit ? 'Save' : 'Add'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
