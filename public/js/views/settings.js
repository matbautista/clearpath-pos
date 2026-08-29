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
