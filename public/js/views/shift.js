async function renderShiftView(container) {
  container.innerHTML = '';
  const header = el('div', { class: 'view-header' }, [el('h2', {}, 'Cash Drawer & Z-Reading')]);
  const body = el('div', {});

  async function load() {
    body.innerHTML = '';
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

      body.appendChild(el('div', { class: 'stat-grid' }, [
        ['Opened At', new Date(current.opened_at).toLocaleString()],
        ['Orders This Shift', String(summary.saleCount)],
        ['Net Sales', money(summary.netSales)],
        ['Expected Cash', money(summary.expectedCash)],
      ].map(([label, value]) => el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]))));

      const methodRows = Object.entries(summary.byMethod).map(([m, v]) => el('div', { class: 'totals-row' }, [el('span', {}, m.toUpperCase()), el('span', {}, money(v))]));

      body.appendChild(el('div', { class: 'card', style: 'max-width:460px;margin-top:16px;' }, [
        el('h3', { style: 'margin-top:0;' }, 'End of Shift — Z-Reading'),
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
      ]));
    }

    const history = await api.get('/api/shifts');
    const tableWrap = el('div', { class: 'card', style: 'margin-top:20px;' }, [el('h3', { style: 'margin-top:0;' }, 'Shift History')]);
    if (history.length === 0) {
      tableWrap.appendChild(el('div', { class: 'empty-state' }, 'No shifts recorded yet.'));
    } else {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Staff', 'Opened', 'Closed', 'Opening Cash', 'Closing Cash', 'Diff', 'Status'].map((h) => el('th', {}, h))))]);
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
        ]));
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    }
    body.appendChild(tableWrap);
  }

  function showZReadingResult(result) {
    const backdrop = el('div', { class: 'modal-backdrop' });
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
        el('div', { style: 'font-size:12px;margin-top:4px;' }, 'Whoever opens the next shift will need to bill them from Tables.'),
      ]) : null,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', onclick: () => window.print() }, 'Print'),
        el('button', { class: 'btn primary', onclick: () => document.body.removeChild(backdrop) }, 'Done'),
      ]),
    ].filter(Boolean));
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  function openCarryOverConfirm(pending, onConfirm) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Pending Table Orders'),
      el('p', { style: 'font-size:13px;color:var(--text-muted);' },
        `${pending.length} table order${pending.length === 1 ? ' is' : 's are'} still open and unbilled. You can close this shift anyway — ${pending.length === 1 ? 'it' : 'they'} will carry over, and whoever opens the next shift will bill ${pending.length === 1 ? 'it' : 'them'} from Tables.`),
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
