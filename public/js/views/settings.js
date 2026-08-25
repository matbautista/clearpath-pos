function resizeImageFile(file, maxWidth) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the image file'));
      img.onload = () => {
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function renderSettingsView(container) {
  container.innerHTML = '';
  const settings = await api.get('/api/settings');

  const fields = {};
  function field(key, label, type = 'text', attrs = {}) {
    const input = el('input', { type, value: settings[key] ?? '', ...attrs });
    fields[key] = input;
    return el('div', { class: 'field' }, [el('label', {}, label), input]);
  }

  const printerEnabled = el('input', { type: 'checkbox' });
  printerEnabled.checked = settings.thermal_printer_enabled === 'true';

  const kitchenPrinterEnabled = el('input', { type: 'checkbox' });
  kitchenPrinterEnabled.checked = settings.kitchen_printer_enabled === 'true';

  const paperWidth = el('select', {}, ['58mm', '80mm'].map((w) => el('option', { value: w, selected: settings.receipt_paper_width === w ? 'true' : null }, w)));

  let currentLogo = settings.store_logo || '';
  const logoPreview = el('img', {
    src: currentLogo || '',
    style: `max-width:160px;max-height:160px;display:${currentLogo ? 'block' : 'none'};margin-bottom:8px;border:1px solid var(--border);border-radius:8px;background:#fff;object-fit:contain;`,
  });
  const logoInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  logoInput.addEventListener('change', async () => {
    const file = logoInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Image is too large (max 8MB)', 'error'); logoInput.value = ''; return; }
    try {
      currentLogo = await resizeImageFile(file, 300);
      logoPreview.src = currentLogo;
      logoPreview.style.display = 'block';
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  const removeLogoBtn = el('button', {
    class: 'btn ghost small',
    onclick: () => { currentLogo = ''; logoPreview.src = ''; logoPreview.style.display = 'none'; logoInput.value = ''; },
  }, 'Remove Logo');

  const form = el('div', { class: 'card', style: 'max-width:520px;' }, [
    el('h3', { style: 'margin-top:0;' }, 'Store Info'),
    field('store_name', 'Store Name'),
    field('store_address', 'Address'),
    field('store_phone', 'Phone'),
    field('store_tin', 'TIN (Tax Identification Number)'),
    el('div', { class: 'field' }, [
      el('label', {}, 'Logo'),
      logoPreview,
      el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [logoInput, removeLogoBtn]),
      el('p', { style: 'color:var(--text-muted);font-size:12px;margin:6px 0 0;' }, 'Shown on printed and emailed receipts. Any image format works — it\'s resized automatically.'),
    ]),
    el('h3', {}, 'Receipts'),
    field('receipt_footer', 'Receipt Footer Message'),
    field('currency_symbol', 'Currency Symbol'),
    field('default_tax_rate', 'Default Tax Rate (0.12 = 12%)', 'number', { step: '0.01', min: '0', max: '1' }),
    el('div', { class: 'field' }, [el('label', {}, 'Receipt Paper Width'), paperWidth]),
    el('h3', {}, 'Thermal Printer (Network / ESC-POS)'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px;margin-top:-6px;' }, 'For WiFi/Ethernet thermal printers listening on a raw port (commonly 9100). For USB printers, share it as a system printer and use browser printing instead. Logo printing works on most printers that support ESC/POS raster images, but quality and support vary by model.'),
    el('div', { class: 'field' }, [el('label', {}, 'Enable Thermal Printing'), printerEnabled]),
    field('thermal_printer_target', 'Printer Address (host:port, e.g. 192.168.1.50:9100)'),
    el('h3', {}, 'Kitchen Printer (Restaurant Table Orders)'),
    el('p', { style: 'color:var(--text-muted);font-size:12.5px;margin-top:-6px;' }, 'A separate network printer at the kitchen station. When staff hit "Send to Kitchen" on a table order, a no-price ticket (items, quantities, notes) prints here.'),
    el('div', { class: 'field' }, [el('label', {}, 'Enable Kitchen Printing'), kitchenPrinterEnabled]),
    field('kitchen_printer_target', 'Kitchen Printer Address (host:port, e.g. 192.168.1.60:9100)'),
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start;padding:0;' }, [
      el('button', { class: 'btn primary', onclick: async () => {
        const payload = {};
        for (const [k, input] of Object.entries(fields)) payload[k] = input.value;
        payload.thermal_printer_enabled = String(printerEnabled.checked);
        payload.kitchen_printer_enabled = String(kitchenPrinterEnabled.checked);
        payload.receipt_paper_width = paperWidth.value;
        payload.store_logo = currentLogo;
        try {
          window.APP_STATE.settings = await api.put('/api/settings', payload);
          toast('Settings saved', 'success');
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Save Settings'),
    ]),
  ]);

  container.appendChild(el('div', { class: 'view-header' }, [el('h2', {}, 'Settings')]));
  container.appendChild(form);

  const channelsCard = el('div', { class: 'card', style: 'max-width:520px;margin-top:16px;' });
  container.appendChild(channelsCard);
  await renderChannelsCard(channelsCard);

  container.appendChild(el('div', { class: 'card', style: 'max-width:520px;margin-top:16px;' }, [
    el('h3', { style: 'margin-top:0;' }, 'Email Receipts'),
    el('p', { style: 'font-size:13px;color:var(--text-muted);' }, 'Configured via the .env file (SMTP_HOST, SMTP_USER, SMTP_PASS) — restart the app after changing it. See README.md.'),
    el('h3', {}, 'GCash / Maya / Card Payments'),
    el('p', { style: 'font-size:13px;color:var(--text-muted);' }, 'This POS records digital wallet and card payments (amount + optional reference/approval code) as tender types during checkout. It does not process live transactions — pair it with your existing GCash/Maya QR code or card terminal, then log the payment here for your records and reporting.'),
  ]));

  const archiveCard = el('div', { class: 'card', style: 'margin-top:16px;' });
  container.appendChild(archiveCard);
  await renderArchiveCard(archiveCard);
}

async function renderArchiveCard(archiveCard) {
  async function refresh() {
    const data = await api.get('/api/archive/years');
    archiveCard.innerHTML = '';
    archiveCard.appendChild(el('h3', { style: 'margin-top:0;' }, 'Sales Archive'));
    archiveCard.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);' },
      `Records from ${data.hotFromYear} onward stay in Reports for fast lookup. Older complete years can be archived — they're exported to a file and moved out, never deleted, and stay searchable below.`));

    const liveRows = data.liveYears.filter((y) => y.eligible);
    if (liveRows.length === 0) {
      archiveCard.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);' }, 'No years are eligible to archive yet.'));
    } else {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Year', 'Records', ''].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      liveRows.forEach((y) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, String(y.year)),
          el('td', {}, String(y.count)),
          el('td', {}, el('button', {
            class: 'btn small',
            onclick: async () => {
              if (!confirm(`Archive all ${y.count} record(s) from ${y.year}? They'll be exported to a file and moved out of live Reports — nothing is deleted.`)) return;
              try {
                const result = await api.post(`/api/archive/${y.year}`);
                toast(`Archived ${result.sale_count} record(s) from ${y.year}`, 'success');
                await refresh();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, `Archive ${y.year}`)),
        ]));
      });
      table.appendChild(tbody);
      archiveCard.appendChild(table);
    }

    archiveCard.appendChild(el('h3', {}, 'Archived Years'));
    if (data.archived.length === 0) {
      archiveCard.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);' }, 'Nothing archived yet.'));
    } else {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Year', 'Records', 'Archived By', 'Archived At', ''].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      const browsePanel = el('div');
      data.archived.forEach((a) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, String(a.year)),
          el('td', {}, String(a.sale_count)),
          el('td', {}, a.archived_by_name || '—'),
          el('td', {}, a.archived_at),
          el('td', {}, el('div', { style: 'display:flex;gap:6px;' }, [
            el('button', { class: 'btn small', onclick: () => renderArchivedYearBrowser(browsePanel, a.year) }, 'View'),
            el('a', { class: 'btn small', href: `/api/archive/${a.year}/download` }, 'Download'),
          ])),
        ]));
      });
      table.appendChild(tbody);
      archiveCard.appendChild(table);
      archiveCard.appendChild(browsePanel);
    }
  }
  await refresh();
}

// Paginated, read-only browser for one archived year's sales — the "stay
// searchable below" promise made above. Renders into `container`, replacing
// whatever was shown for a previously-picked year.
async function renderArchivedYearBrowser(container, year) {
  let page = 1;
  const PAGE_SIZE = 20;

  async function load() {
    const { sales, total } = await api.get(`/api/archive/${year}/sales?page=${page}&pageSize=${PAGE_SIZE}`);
    container.innerHTML = '';
    const card = el('div', { class: 'card', style: 'margin-top:10px;' });
    card.appendChild(el('h4', { style: 'margin-top:0;' }, `${year} Archived Sales`));
    if (total === 0) {
      card.appendChild(el('div', { class: 'empty-state' }, 'No archived sales found for this year.'));
      container.appendChild(card);
      return;
    }
    const table = el('table', {}, [el('thead', {}, el('tr', {},
      ['Receipt #', 'Date', 'Cashier', 'Customer', 'Total', 'Status', ''].map((h) => el('th', {}, h))))]);
    const tbody = el('tbody');
    sales.forEach((s) => {
      tbody.appendChild(el('tr', {}, [
        el('td', {}, s.sale_number),
        el('td', {}, s.created_at),
        el('td', {}, s.cashier_name || '—'),
        el('td', {}, s.customer_name || '—'),
        el('td', {}, money(s.total)),
        el('td', {}, el('span', { class: `badge ${s.status}` }, s.status.replace('_', ' '))),
        el('td', {}, el('button', { class: 'btn small', onclick: () => openArchivedSaleDetailModal(s.id) }, 'View')),
      ]));
    });
    table.appendChild(tbody);
    card.appendChild(table);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    card.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:12px;' }, [
      el('span', { style: 'color:var(--text-muted);font-size:13px;' }, `Page ${page} of ${totalPages} (${total} total)`),
      el('div', { style: 'display:flex;gap:8px;' }, [
        el('button', { class: 'btn small', disabled: page <= 1 ? 'true' : null, onclick: () => { page -= 1; load(); } }, 'Prev'),
        el('button', { class: 'btn small', disabled: page >= totalPages ? 'true' : null, onclick: () => { page += 1; load(); } }, 'Next'),
      ]),
    ]));
    container.appendChild(card);
  }
  await load();
}

async function openArchivedSaleDetailModal(saleId) {
  const sale = await api.get(`/api/archive/sales/${saleId}`);
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal', style: 'width:520px;' }, [
    el('h3', {}, `Sale ${sale.sale_number} (Archived)`),
    el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:10px;' }, [
      `${sale.created_at} · Cashier: ${sale.cashier_name || '—'}`,
      sale.table_name ? ` · Table: ${sale.table_name}` : '',
      sale.customer_name ? ` · Customer: ${sale.customer_name}` : '',
    ]),
    el('span', { class: `badge ${sale.status}` }, sale.status.replace('_', ' ')),
    el('table', { style: 'margin-top:12px;' }, [
      el('thead', {}, el('tr', {}, ['Item', 'Qty', 'Refunded', 'Line Total'].map((h) => el('th', {}, h)))),
      el('tbody', {}, sale.items.map((i) => el('tr', {}, [
        el('td', {}, i.voided ? `${i.name} (removed, not charged)` : i.name),
        el('td', {}, String(i.qty)),
        el('td', {}, String(i.refunded_qty)),
        el('td', {}, i.voided ? '—' : money(i.line_total)),
      ]))),
    ]),
    sale.discount_total ? el('div', { class: 'totals-row' }, [el('span', {}, 'Discount'), el('span', {}, `-${money(sale.discount_total)}`)]) : null,
    sale.vat_exempt_total ? el('div', { class: 'totals-row' }, [el('span', {}, 'VAT-Exempt Sales'), el('span', {}, money(sale.vat_exempt_total))]) : null,
    el('div', { class: 'totals-row grand' }, [el('span', {}, 'Total'), el('span', {}, money(sale.total))]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Close'),
    ]),
  ].filter(Boolean));
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });
}

async function renderChannelsCard(card) {
  async function refresh() {
    const channels = await api.get('/api/channels');
    card.innerHTML = '';
    card.appendChild(el('h3', { style: 'margin-top:0;' }, 'Order Channels'));
    card.appendChild(el('p', { style: 'font-size:13px;color:var(--text-muted);' },
      'Where orders come from — walk-in/dine-in vs. delivery marketplaces like FoodPanda or GrabFood. Staff pick the channel at checkout; commission % is what that platform keeps, so Reports can show net (after-commission) revenue per channel.'));

    if (channels.length > 0) {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Channel', 'Commission %', 'Status', ''].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      channels.forEach((c) => {
        const rateInput = el('input', { type: 'number', step: '1', min: '0', max: '100', value: String(Math.round(c.commission_rate * 100)), style: 'width:80px;' });
        tbody.appendChild(el('tr', {}, [
          el('td', {}, c.name),
          el('td', {}, rateInput),
          el('td', {}, el('span', { class: `badge ${c.active ? 'completed' : 'voided'}` }, c.active ? 'Active' : 'Inactive')),
          el('td', {}, el('div', { style: 'display:flex;gap:6px;' }, [
            el('button', {
              class: 'btn small',
              onclick: async () => {
                try {
                  await api.put(`/api/channels/${c.id}`, { commission_rate: Number(rateInput.value) / 100 });
                  toast(`${c.name} updated`, 'success');
                  refresh();
                } catch (e) { toast(e.message, 'error'); }
              },
            }, 'Save'),
            el('button', {
              class: `btn small ${c.active ? '' : 'success'}`,
              onclick: async () => {
                try {
                  await api.put(`/api/channels/${c.id}`, { active: !c.active });
                  toast(`${c.name} ${c.active ? 'deactivated' : 'activated'}`, 'success');
                  refresh();
                } catch (e) { toast(e.message, 'error'); }
              },
            }, c.active ? 'Deactivate' : 'Activate'),
          ])),
        ]));
      });
      table.appendChild(tbody);
      card.appendChild(table);
    }

    const nameInput = el('input', { type: 'text', placeholder: 'e.g. FoodPanda' });
    const pctInput = el('input', { type: 'number', step: '1', min: '0', max: '100', value: '20', style: 'width:90px;' });
    card.appendChild(el('div', { class: 'form-row', style: 'margin-top:14px;align-items:flex-end;' }, [
      el('div', { class: 'field', style: 'margin-bottom:0;flex:1;' }, [el('label', {}, 'New Channel'), nameInput]),
      el('div', { class: 'field', style: 'margin-bottom:0;flex:0 0 auto;' }, [el('label', {}, 'Commission %'), pctInput]),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!nameInput.value.trim()) return;
          try {
            await api.post('/api/channels', { name: nameInput.value.trim(), commission_rate: Number(pctInput.value) / 100 });
            toast('Channel added', 'success');
            refresh();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Add'),
    ]));
  }
  await refresh();
}
