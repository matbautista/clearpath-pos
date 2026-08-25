function stockStatusOf(p) {
  if (!p.track_stock) return 'unlimited';
  if (p.stock_qty <= 0) return 'out';
  if (p.stock_qty <= p.low_stock_threshold) return 'low';
  return 'in';
}

async function renderInventoryView(container) {
  container.innerHTML = '';
  let products = [];
  let categories = [];
  let lowStock = [];
  let query = '';
  let categoryId = '';
  let stockStatus = '';

  async function loadAll() {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (categoryId) params.set('category_id', categoryId);
    const qs = params.toString();
    [products, categories, lowStock] = await Promise.all([
      api.get(`/api/products${qs ? `?${qs}` : ''}`),
      api.get('/api/categories'),
      api.get('/api/products/low-stock'),
    ]);
  }
  await loadAll();

  const header = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Inventory'),
    el('div', {}, [
      el('button', { class: 'btn ghost', onclick: () => openCategoryModal(rerender) }, 'Categories'),
      el('button', { class: 'btn primary', onclick: () => openProductModal(null, categories, rerender) }, '+ Add Product'),
    ]),
  ]);

  const body = el('div', {});

  async function rerender() {
    await loadAll();
    body.innerHTML = '';
    if (lowStock.length > 0) {
      body.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px;background:#fdf2e0;border-color:#f0d9a8;color:#4a3510;' }, [
        el('strong', {}, `⚠ ${lowStock.length} product(s) low on stock: `),
        el('span', {}, lowStock.map((p) => p.name).join(', ')),
      ]));
    }

    const searchInput = el('input', { type: 'text', placeholder: 'Search by name, SKU, or barcode…', value: query, style: 'max-width:320px;' });
    searchInput.addEventListener('input', async () => { query = searchInput.value; await loadAll(); renderTable(); });

    const categoryFilter = el('select', { style: 'max-width:200px;' }, [
      el('option', { value: '' }, 'All Categories'),
      ...categories.map((c) => el('option', { value: String(c.id), selected: String(c.id) === categoryId ? 'true' : null }, c.name)),
    ]);
    categoryFilter.addEventListener('change', async () => { categoryId = categoryFilter.value; await loadAll(); renderTable(); });

    const stockFilter = el('select', { style: 'max-width:200px;' }, [
      ['', 'All Stock Statuses'],
      ['in', 'In Stock'],
      ['low', 'Low Stock'],
      ['out', 'Out of Stock'],
      ['unlimited', 'Unlimited (Made to Order)'],
    ].map(([value, label]) => el('option', { value, selected: value === stockStatus ? 'true' : null }, label)));
    stockFilter.addEventListener('change', () => { stockStatus = stockFilter.value; renderTable(); });

    body.appendChild(el('div', { style: 'display:flex;gap:10px;margin-bottom:14px;' }, [searchInput, categoryFilter, stockFilter]));

    const tableWrap = el('div', { class: 'card' });
    body.appendChild(tableWrap);

    function renderTable() {
      tableWrap.innerHTML = '';
      const table = el('table', {}, [
        el('thead', {}, el('tr', {}, ['', 'Name', 'SKU', 'Barcode', 'Category', 'Price', 'Cost', 'Stock', 'Tax', 'Status', ''].map((h) => el('th', {}, h)))),
      ]);
      const tbody = el('tbody');
      const rows = stockStatus ? products.filter((p) => stockStatusOf(p) === stockStatus) : products;
      rows.forEach((p) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, p.image_url
            ? el('img', { src: p.image_url, style: `width:36px;height:36px;object-fit:cover;border-radius:6px;display:block;${p.active ? '' : 'opacity:.4;'}` })
            : el('div', { style: `width:36px;height:36px;border-radius:6px;background:${p.color || '#4f7cff'};${p.active ? '' : 'opacity:.4;'}` })),
          el('td', { style: p.active ? '' : 'color:var(--text-muted);' }, p.name),
          el('td', {}, p.sku || '—'),
          el('td', {}, p.barcode || '—'),
          el('td', {}, p.category_name || '—'),
          el('td', {}, money(p.price)),
          el('td', {}, money(p.cost)),
          el('td', {}, p.track_stock ? String(p.stock_qty) : '∞'),
          el('td', {}, `${(p.tax_rate * 100).toFixed(0)}%`),
          el('td', {}, el('span', { class: `badge ${p.active ? 'completed' : 'voided'}` }, p.active ? 'Available' : 'Unavailable')),
          el('td', {}, el('div', { style: 'display:flex;gap:6px;' }, [
            el('button', { class: 'btn small', onclick: () => openProductModal(p, categories, rerender) }, 'Edit'),
            el('button', { class: 'btn small', onclick: () => openStockAdjustModal(p, rerender) }, 'Stock'),
            el('button', {
              class: `btn small ${p.active ? '' : 'success'}`,
              onclick: async () => {
                try {
                  await api.put(`/api/products/${p.id}`, { active: !p.active });
                  toast(`${p.name} marked ${p.active ? 'unavailable' : 'available'}`, 'success');
                  rerender();
                } catch (e) { toast(e.message, 'error'); }
              },
            }, p.active ? 'Turn Off' : 'Turn On'),
          ])),
        ]));
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      if (rows.length === 0) tableWrap.appendChild(el('div', { class: 'empty-state' }, 'No products found.'));
    }
    renderTable();
  }

  await rerender();
  container.appendChild(header);
  container.appendChild(body);
}

function openProductModal(product, categories, onDone) {
  const isEdit = Boolean(product);
  const defaultTaxRate = Number(window.APP_STATE.settings.default_tax_rate) || 0.12;
  const data = product ? { ...product } : { name: '', sku: '', barcode: '', category_id: '', price: 0, cost: 0, tax_rate: defaultTaxRate, stock_qty: 0, low_stock_threshold: 5, track_stock: true, color: '#4f7cff', image_url: '' };

  const backdrop = el('div', { class: 'modal-backdrop' });
  const nameInput = el('input', { type: 'text', value: data.name });
  const skuInput = el('input', { type: 'text', value: data.sku || '' });
  const barcodeInput = el('input', { type: 'text', value: data.barcode || '' });
  const imageUrlInput = el('input', { type: 'text', value: data.image_url || '', placeholder: '/assets/menu/dish.jpg or a full URL' });
  const priceInput = el('input', { type: 'number', step: '0.01', value: String(data.price) });
  const costInput = el('input', { type: 'number', step: '0.01', value: String(data.cost) });
  const taxInput = el('input', { type: 'number', step: '0.01', min: '0', max: '1', value: String(data.tax_rate) });
  const stockInput = el('input', { type: 'number', step: '1', value: String(data.stock_qty) });
  const lowStockInput = el('input', { type: 'number', step: '1', value: String(data.low_stock_threshold) });
  const trackStockInput = el('input', { type: 'checkbox' });
  trackStockInput.checked = Boolean(data.track_stock);
  const colorInput = el('input', { type: 'color', value: data.color || '#4f7cff' });
  const categorySelect = el('select', {}, [
    el('option', { value: '' }, 'Uncategorized'),
    ...categories.map((c) => el('option', { value: c.id, selected: c.id === data.category_id ? 'true' : null }, c.name)),
  ]);

  const errorEl = el('div', { class: 'login-error' }, '');

  async function save() {
    const payload = {
      name: nameInput.value.trim(),
      sku: skuInput.value.trim() || null,
      barcode: barcodeInput.value.trim() || null,
      category_id: categorySelect.value ? Number(categorySelect.value) : null,
      price: Number(priceInput.value),
      cost: Number(costInput.value),
      tax_rate: Number(taxInput.value),
      stock_qty: Number(stockInput.value),
      low_stock_threshold: Number(lowStockInput.value),
      track_stock: trackStockInput.checked,
      color: colorInput.value,
      image_url: imageUrlInput.value.trim() || null,
    };
    if (!payload.name) { errorEl.textContent = 'Name is required'; return; }
    if (!(payload.tax_rate >= 0 && payload.tax_rate <= 1)) {
      errorEl.textContent = 'Tax rate must be a fraction between 0 and 1 (e.g. 0.12 for 12%)';
      return;
    }
    try {
      if (isEdit) await api.put(`/api/products/${product.id}`, payload);
      else await api.post('/api/products', payload);
      document.body.removeChild(backdrop);
      onDone();
    } catch (e) {
      errorEl.textContent = e.message;
    }
  }

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, isEdit ? 'Edit Product' : 'Add Product'),
    el('div', { class: 'field' }, [el('label', {}, 'Name'), nameInput]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'SKU'), skuInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Barcode'), barcodeInput]),
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Category'), categorySelect]),
    el('div', { class: 'field' }, [el('label', {}, 'Photo (path or URL, optional)'), imageUrlInput]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Price'), priceInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Cost'), costInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Tax rate (0.12 = 12%)'), taxInput]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Stock Qty'), stockInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Low Stock Alert At'), lowStockInput]),
    ]),
    el('div', { class: 'form-row' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Tile Color'), colorInput]),
      el('div', { class: 'field' }, [el('label', {}, 'Track Stock'), trackStockInput]),
    ]),
    errorEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: save }, isEdit ? 'Save' : 'Add Product'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function openStockAdjustModal(product, onDone) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const qtyInput = el('input', { type: 'number', step: '1', value: '0' });
  const noteInput = el('input', { type: 'text', placeholder: 'e.g. restock delivery, inventory count fix' });
  const errorEl = el('div', { class: 'login-error' }, '');

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, `Adjust Stock — ${product.name}`),
    el('p', { style: 'color:var(--text-muted);font-size:13px;' }, `Current stock: ${product.stock_qty}`),
    el('div', { class: 'field' }, [el('label', {}, 'Change (use negative to subtract)'), qtyInput]),
    el('div', { class: 'field' }, [el('label', {}, 'Note'), noteInput]),
    errorEl,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: async () => {
        try {
          const changeQty = Number(qtyInput.value);
          // A positive change is stock coming in (restock); negative is a
          // correction (spoilage, shrinkage, recount) — tagging both as
          // 'restock' would mislabel every reduction in the audit trail.
          await api.post(`/api/products/${product.id}/adjust-stock`, { change_qty: changeQty, reason: changeQty > 0 ? 'restock' : 'adjustment', note: noteInput.value });
          document.body.removeChild(backdrop);
          onDone();
        } catch (e) { errorEl.textContent = e.message; }
      } }, 'Apply'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function openCategoryModal(onDone) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const nameInput = el('input', { type: 'text', placeholder: 'New category name' });
  const listEl = el('div', { style: 'margin:10px 0;max-height:200px;overflow-y:auto;' });

  async function refresh() {
    const cats = await api.get('/api/categories');
    listEl.innerHTML = '';
    cats.forEach((c) => {
      listEl.appendChild(el('div', { class: 'totals-row' }, [
        el('span', {}, c.name),
        el('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Delete "${c.name}"? Any products in this category will become Uncategorized — they won't be deleted.`)) return;
          try { await api.del(`/api/categories/${c.id}`); refresh(); } catch (e) { toast(e.message, 'error'); }
        } }, 'Delete'),
      ]));
    });
  }
  refresh();

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Categories'),
    listEl,
    el('div', { class: 'field' }, [nameInput]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => { document.body.removeChild(backdrop); onDone(); } }, 'Close'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!nameInput.value.trim()) return;
        try {
          await api.post('/api/categories', { name: nameInput.value.trim() });
          nameInput.value = '';
          refresh();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Add'),
    ]),
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}
