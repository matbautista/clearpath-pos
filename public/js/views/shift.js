async function renderShiftView(container) {
  container.innerHTML = '';
  const header = el('div', { class: 'view-header' }, [el('h2', {}, 'Cash Drawer & Z-Reading')]);
  const body = el('div', {});
  // Admin/manager are view-only here — they can see whichever cashier
  // currently has the drawer open, but can't open, close, or otherwise
  // transact on it themselves.
  const isViewOnly = ['admin', 'manager'].includes(window.APP_STATE.user.role);

  async function load() {
    body.innerHTML = '';
    if (isViewOnly) return loadViewOnly();

    const current = await api.get('/api/shifts/current');
    window.APP_STATE.shift = current;

    if (!current) {
      const openInput = el('input', { type: 'number', step: '0.01', min: '0', value: '0', placeholder: 'Opening cash amount' });
      body.appendChild(el('div', { class: 'card', style: 'max-width:420px;' }, [
        el('h3', { style: 'margin-top:0;' }, 'Open a New Shift'),
        el('div', { class: 'field' }, [el('label', {}, 'Starting Cash in Drawer'), openInput]),
        el('button', { class: 'btn primary', onclick: async () => {
          try {
            await api.post('/api/shifts/open', { opening_cash: Number(openInput.value) || 0 });
            load();
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Open Shift'),
      ]));
    } else {
      const summary = await api.get(`/api/shifts/${current.id}/summary`);
      const closeInput = el('input', { type: 'number', step: '0.01', min: '0', value: String(summary.expectedCash.toFixed(2)) });
      const methodRows = Object.entries(summary.byMethod).map(([m, v]) => el('div', { class: 'totals-row' }, [el('span', {}, m.toUpperCase()), el('span', {}, money(v))]));

      body.appendChild(el('div', { class: 'card' }, [
        el('h3', { style: 'margin-top:0;' }, 'End of Shift — Z-Reading'),
        el('div', { class: 'stat-grid single-line', style: 'margin-bottom:16px;' }, [
          ['Opened At', new Date(current.opened_at).toLocaleString()],
          ['Orders This Shift', String(summary.saleCount)],
          ['Net Sales', money(summary.netSales)],
          ['Expected Cash', money(summary.expectedCash)],
        ].map(([label, value]) => el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]))),
        el('div', { style: 'max-width:460px;' }, [
          el('div', { class: 'totals-row' }, [el('span', {}, 'Opening Cash'), el('span', {}, money(summary.openingCash))]),
          ...methodRows,
          el('div', { class: 'totals-row' }, [el('span', {}, 'Refunds'), el('span', {}, `-${money(summary.refunds)}`)]),
          el('div', { class: 'totals-row grand' }, [el('span', {}, 'Expected Cash in Drawer'), el('span', {}, money(summary.expectedCash))]),
          el('div', { class: 'field', style: 'margin-top:14px;' }, [el('label', {}, 'Actual Counted Cash'), closeInput]),
          el('button', { class: 'btn danger', onclick: async () => {
            async function doClose() {
              try {
                const result = await api.post(`/api/shifts/${current.id}/close`, { closing_cash: Number(closeInput.value) });
                showZReadingResult(result);
                load();
              } catch (e) { toast(e.message, 'error'); }
            }
            let pending = [];
            try {
              pending = await api.get(`/api/shifts/${current.id}/pending-orders`);
            } catch (e) { toast(e.message, 'error'); return; }
            if (pending.length > 0) {
              openCarryOverConfirm(pending, doClose);
            } else if (confirm('Close this shift? This finalizes the Z-Reading.')) {
              doClose();
            }
          } }, 'Close Shift & Generate Z-Reading'),
        ]),
      ]));

      await renderTransactionsList(current.id);
    }
  }

  // Read-only counterpart to load(): shows whichever cashier currently has
  // the drawer open (there's at most one, per the one-cashier-at-a-time
  // rule), with no open/close controls — admin/manager can watch it, not
  // touch it.
  async function loadViewOnly() {
    const active = await api.get('/api/shifts/active');
    if (!active) {
      body.appendChild(el('div', { class: 'card', style: 'max-width:420px;' }, [
        el('h3', { style: 'margin-top:0;' }, 'No Cashier On Shift'),
        el('p', { style: 'color:var(--text-muted);font-size:14px;' }, 'No cash drawer is currently open.'),
      ]));
    } else {
      const summary = active.summary;
      const methodRows = Object.entries(summary.byMethod).map(([m, v]) => el('div', { class: 'totals-row' }, [el('span', {}, m.toUpperCase()), el('span', {}, money(v))]));
      body.appendChild(el('div', { class: 'card' }, [
        el('h3', { style: 'margin-top:0;' }, `${active.user_name}'s Drawer (view only)`),
        el('div', { class: 'stat-grid single-line', style: 'margin-bottom:16px;' }, [
          ['Cashier', active.user_name],
          ['Opened At', new Date(active.opened_at).toLocaleString()],
          ['Orders This Shift', String(summary.saleCount)],
          ['Net Sales', money(summary.netSales)],
          ['Expected Cash', money(summary.expectedCash)],
        ].map(([label, value]) => el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]))),
        el('div', { style: 'max-width:460px;' }, [
          el('div', { class: 'totals-row' }, [el('span', {}, 'Opening Cash'), el('span', {}, money(summary.openingCash))]),
          ...methodRows,
          el('div', { class: 'totals-row' }, [el('span', {}, 'Refunds'), el('span', {}, `-${money(summary.refunds)}`)]),
          el('div', { class: 'totals-row grand' }, [el('span', {}, 'Expected Cash in Drawer'), el('span', {}, money(summary.expectedCash))]),
        ]),
      ]));
      await renderTransactionsList(active.id);
    }
    await renderHistoryTable();
  }

  // What the cashier's (or, for admin/manager, the active cashier's)
  // aggregate summary above is actually made of — every sale billed under
  // this shift, including voided/refunded ones so the list matches what
  // really happened.
  // Shared by the live "this shift" view and the historical shift-detail
  // modal below, so both render transactions identically.
  function buildTransactionsTable(sales) {
    if (sales.length === 0) return el('div', { class: 'empty-state' }, 'No transactions yet.');
    const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Receipt #', 'Time', 'Table / Slot', 'Customer', 'Total', 'Status'].map((h) => el('th', {}, h))))]);
    const tbody = el('tbody');
    sales.forEach((s) => {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, s.sale_number),
        el('td', {}, new Date(s.billed_at).toLocaleString()),
        el('td', {}, s.table_name || '—'),
        el('td', {}, s.customer_name || '—'),
        el('td', {}, money(s.total)),
        el('td', {}, el('span', { class: `badge ${s.status}` }, s.status.replace('_', ' '))),
      ]));
    });
    table.appendChild(tbody);
    return table;
  }

  async function renderTransactionsList(shiftId) {
    const sales = await api.get(`/api/shifts/${shiftId}/sales`);
    body.appendChild(el('div', { class: 'card', style: 'max-width:760px;margin-top:16px;' }, [
      el('h3', { style: 'margin-top:0;' }, 'Transactions This Shift'),
      buildTransactionsTable(sales),
    ]));
  }

  // Paginated (not a flat top-50) so a shift from months back stays
  // reachable — shifts are never archived, so the full history always lives
  // in the same table, just further back in id order.
  async function renderHistoryTable() {
    const tableWrap = el('div', { class: 'card', style: 'margin-top:20px;' });
    body.appendChild(tableWrap);

    let page = 1;
    const PAGE_SIZE = 20;

    async function load() {
      const { shifts: history, total } = await api.get(`/api/shifts?page=${page}&pageSize=${PAGE_SIZE}`);
      tableWrap.innerHTML = '';
      tableWrap.appendChild(el('h3', { style: 'margin-top:0;' }, 'Shift History'));
      if (history.length === 0) {
        tableWrap.appendChild(el('div', { class: 'empty-state' }, 'No shifts recorded yet.'));
        return;
      }
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Staff', 'Opened', 'Closed', 'Opening Cash', 'Closing Cash', 'Diff', 'Status', ''].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      history.forEach((s) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, s.user_name),
          el('td', {}, new Date(s.opened_at).toLocaleString()),
          el('td', {}, s.closed_at ? new Date(s.closed_at).toLocaleString() : '—'),
          el('td', {}, money(s.opening_cash)),
          el('td', {}, s.closing_cash !== null ? money(s.closing_cash) : '—'),
          el('td', {}, s.cash_diff !== null ? money(s.cash_diff) : '—'),
          el('td', {}, el('span', { class: `badge ${s.status === 'open' ? 'completed' : 'refunded'}` }, s.status)),
          el('td', {}, el('button', { class: 'btn small', onclick: () => openShiftDetailModal(s) }, 'View')),
        ]));
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);

      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      tableWrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:12px;' }, [
        el('span', { style: 'color:var(--text-muted);font-size:13px;' }, `Page ${page} of ${totalPages} (${total} total)`),
        el('div', { style: 'display:flex;gap:8px;' }, [
          el('button', { class: 'btn small', disabled: page <= 1 ? 'true' : null, onclick: () => { page -= 1; load(); } }, 'Prev'),
          el('button', { class: 'btn small', disabled: page >= totalPages ? 'true' : null, onclick: () => { page += 1; load(); } }, 'Next'),
        ]),
      ]));
    }
    await load();
  }

  // Reopens a past (or currently open) shift's full Z-Reading — the same
  // detail the one-time popup shows right after closing, but reachable any
  // time from Shift History, with its own Print.
  async function openShiftDetailModal(shift) {
    const backdrop = el('div', { class: 'modal-backdrop zreading-modal' });
    const modal = el('div', { class: 'modal', style: 'width:540px;' }, [el('div', { class: 'empty-state' }, 'Loading…')]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });

    const [summary, sales] = await Promise.all([
      api.get(`/api/shifts/${shift.id}/summary`),
      api.get(`/api/shifts/${shift.id}/sales`),
    ]);

    modal.innerHTML = '';
    modal.appendChild(el('h3', {}, `${shift.user_name}'s Shift — Z-Reading`));
    modal.appendChild(el('div', { style: 'font-size:13px;color:var(--text-muted);margin-top:-6px;margin-bottom:10px;' },
      `${new Date(shift.opened_at).toLocaleString()} — ${shift.closed_at ? new Date(shift.closed_at).toLocaleString() : 'still open'}`));
    modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, 'Orders'), el('span', {}, String(summary.saleCount))]));
    modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, 'Net Sales'), el('span', {}, money(summary.netSales))]));
    Object.entries(summary.byMethod).forEach(([m, v]) => {
      modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, m.toUpperCase()), el('span', {}, money(v))]));
    });
    modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, 'Refunds'), el('span', {}, `-${money(summary.refunds)}`)]));
    modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, 'Expected Cash'), el('span', {}, money(summary.expectedCash))]));
    modal.appendChild(el('div', { class: 'totals-row' }, [el('span', {}, 'Counted Cash'), el('span', {}, shift.closing_cash !== null ? money(shift.closing_cash) : '—')]));
    modal.appendChild(el('div', { class: 'totals-row grand' }, [el('span', {}, 'Difference'), el('span', {}, shift.cash_diff !== null ? money(shift.cash_diff) : '—')]));

    modal.appendChild(el('h4', { style: 'margin-top:16px;' }, 'Transactions'));
    modal.appendChild(buildTransactionsTable(sales));

    modal.appendChild(el('div', { class: 'modal-actions', style: 'flex-wrap:wrap;justify-content:flex-start;' }, [
      el('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print (browser)'),
      el('button', { class: 'btn', onclick: async () => {
        try { await api.post(`/api/shifts/${shift.id}/receipt/print`); toast('Sent to thermal printer', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      } }, '🧾 Print (thermal)'),
      el('button', { class: 'btn primary', onclick: () => document.body.removeChild(backdrop) }, 'Close'),
    ]));
  }

  function showZReadingResult(result) {
    const backdrop = el('div', { class: 'modal-backdrop zreading-modal' });
    const carried = result.carriedOverOrders || [];
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Z-Reading Summary'),
      el('div', { class: 'totals-row' }, [el('span', {}, 'Orders'), el('span', {}, String(result.saleCount))]),
      el('div', { class: 'totals-row' }, [el('span', {}, 'Net Sales'), el('span', {}, money(result.netSales))]),
      ...Object.entries(result.byMethod).map(([m, v]) => el('div', { class: 'totals-row' }, [el('span', {}, m.toUpperCase()), el('span', {}, money(v))])),
      el('div', { class: 'totals-row' }, [el('span', {}, 'Expected Cash'), el('span', {}, money(result.expectedCash))]),
      el('div', { class: 'totals-row' }, [el('span', {}, 'Counted Cash'), el('span', {}, money(result.closingCash))]),
      el('div', { class: 'totals-row grand' }, [el('span', {}, 'Difference'), el('span', {}, money(result.cashDiff))]),
      carried.length > 0 ? el('div', { class: 'card', style: 'margin-top:14px;background:#fdf2e0;border-color:#f0d9a8;color:#4a3510;padding:10px 14px;' }, [
        el('strong', {}, `⚠ ${carried.length} order${carried.length === 1 ? '' : 's'} carried over: `),
        carried.map((o) => o.table_name || o.sale_number).join(', '),
        el('div', { style: 'font-size:12px;margin-top:4px;' }, 'Whoever opens the next shift will need to bill them from Tables or Register.'),
      ]) : null,
      el('div', { class: 'modal-actions', style: 'flex-wrap:wrap;justify-content:flex-start;' }, [
        el('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print (browser)'),
        el('button', { class: 'btn', onclick: async () => {
          try { await api.post(`/api/shifts/${result.shift.id}/receipt/print`); toast('Sent to thermal printer', 'success'); }
          catch (e) { toast(e.message, 'error'); }
        } }, '🧾 Print (thermal)'),
        el('button', { class: 'btn primary', onclick: () => document.body.removeChild(backdrop) }, 'Done'),
      ]),
    ].filter(Boolean));
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  function openCarryOverConfirm(pending, onConfirm) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Pending Orders'),
      el('p', { style: 'font-size:13px;color:var(--text-muted);' },
        `${pending.length} order${pending.length === 1 ? ' is' : 's are'} still open and unbilled. You can close this shift anyway — ${pending.length === 1 ? 'it' : 'they'} will carry over, and whoever opens the next shift will bill ${pending.length === 1 ? 'it' : 'them'} from Tables or Register.`),
      el('div', { style: 'margin:10px 0;max-height:220px;overflow-y:auto;' }, pending.map((p) => el('div', { class: 'totals-row' }, [
        el('span', {}, p.table_name || p.sale_number),
        el('span', {}, `${p.item_count} item(s) · ${money(p.total)}`),
      ]))),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
        el('button', { class: 'btn danger', onclick: () => { document.body.removeChild(backdrop); onConfirm(); } }, 'Close & Carry Over'),
      ]),
    ]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  await load();
  container.appendChild(header);
  container.appendChild(body);
}
