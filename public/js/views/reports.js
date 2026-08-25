async function renderReportsView(container) {
  container.innerHTML = '';
  let page = 'summary';

  const pageTabs = el('div', { class: 'category-tabs' }, [
    el('button', { class: 'active', onclick: () => switchPage('summary') }, 'Summary'),
    el('button', { class: '', onclick: () => switchPage('metrics') }, 'Metrics'),
  ]);
  const pageHeader = el('div', { class: 'view-header' }, [
    el('h2', {}, 'Reports'),
    pageTabs,
  ]);
  const pageBody = el('div');

  function switchPage(p) {
    page = p;
    pageTabs.querySelectorAll('button').forEach((b, idx) => b.classList.toggle('active', ['summary', 'metrics'][idx] === p));
    renderPageBody();
  }
  function renderPageBody() {
    pageBody.innerHTML = '';
    if (page === 'summary') renderSummaryTab(pageBody);
    else renderMetricsTab(pageBody);
  }

  container.appendChild(pageHeader);
  container.appendChild(pageBody);
  renderPageBody();
}

async function renderSummaryTab(container) {
  const today = new Date().toISOString().slice(0, 10);
  let period = 'today';
  let customFrom = today;
  let customTo = today;
  let salesPage = 1;
  const SALES_PAGE_SIZE = 20;

  const periodLabels = { today: 'Today', week: 'Week', month: 'Month', year: 'Year', custom: 'Custom' };
  const tabsRow = el('div', { class: 'category-tabs' }, Object.keys(periodLabels).map((p) =>
    el('button', { class: p === period ? 'active' : '', onclick: () => { period = p; salesPage = 1; load(); } }, periodLabels[p])
  ));

  const fromInput = el('input', { type: 'date', value: customFrom, max: today });
  const toInput = el('input', { type: 'date', value: customTo, max: today });
  const rangeError = el('span', { style: 'color:var(--danger);font-size:12px;' }, '');
  const customRangeRow = el('div', { style: 'display:none;align-items:center;gap:8px;' }, [
    el('span', { style: 'font-size:12.5px;color:var(--text-muted);' }, 'From'),
    fromInput,
    el('span', { style: 'font-size:12.5px;color:var(--text-muted);' }, 'To'),
    toInput,
    el('button', { class: 'btn small primary', onclick: () => {
      if (!fromInput.value || !toInput.value) { rangeError.textContent = 'Pick both dates'; return; }
      if (fromInput.value > toInput.value) { rangeError.textContent = '"From" must be before "To"'; return; }
      rangeError.textContent = '';
      customFrom = fromInput.value; customTo = toInput.value; salesPage = 1; load();
    } }, 'Apply'),
    rangeError,
  ]);

  const periodBar = el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px;' }, [tabsRow, customRangeRow]);

  const statsGrid = el('div', { class: 'stat-grid' });
  const topProductsCard = el('div', { class: 'card', style: 'margin-bottom:18px;' });
  const salesCard = el('div', { class: 'card' });

  async function load() {
    // re-render tab active state + custom range row visibility
    tabsRow.querySelectorAll('button').forEach((b, idx) => {
      b.classList.toggle('active', Object.keys(periodLabels)[idx] === period);
    });
    customRangeRow.style.display = period === 'custom' ? 'flex' : 'none';

    const rangeQs = period === 'custom'
      ? `from=${encodeURIComponent(`${customFrom} 00:00:00`)}&to=${encodeURIComponent(`${customTo} 23:59:59`)}`
      : `period=${period}`;

    const [summary, topProducts, salesPageResult] = await Promise.all([
      api.get(`/api/reports/summary?${rangeQs}`),
      api.get(`/api/reports/top-products?${rangeQs}&limit=8`),
      api.get(`/api/sales?${rangeQs}&page=${salesPage}&pageSize=${SALES_PAGE_SIZE}`),
    ]);
    const { sales, total: salesTotal } = salesPageResult;

    statsGrid.innerHTML = '';
    const methodLine = summary.byMethod.map((m) => `${m.method}: ${money(m.total)}`).join(' · ') || 'No payments yet';
    [
      ['Revenue', money(summary.revenue)],
      ['Orders', summary.orders.toLocaleString('en-US')],
      ['Avg. Order', money(summary.avgOrder)],
      ['Refunds', money(summary.refunds)],
    ].forEach(([label, value]) => {
      statsGrid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]));
    });
    statsGrid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, 'By Payment Method'), el('div', { style: 'font-size:13px;margin-top:6px;' }, methodLine)]));
    const channelLine = summary.byChannel.map((c) => `${c.name}: ${money(c.revenue)}${c.commission_rate ? ` (net ${money(c.net_revenue)})` : ''}`).join(' · ') || 'No sales yet';
    statsGrid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, 'By Channel'), el('div', { style: 'font-size:13px;margin-top:6px;' }, channelLine)]));

    topProductsCard.innerHTML = '';
    topProductsCard.appendChild(el('h3', { style: 'margin-top:0;' }, 'Top-Selling Products'));
    if (topProducts.length === 0) {
      topProductsCard.appendChild(el('div', { class: 'empty-state' }, 'No sales in this period yet.'));
    } else {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Product', 'Qty Sold', 'Revenue'].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      topProducts.forEach((p) => tbody.appendChild(el('tr', {}, [el('td', {}, p.name), el('td', {}, p.qty_sold.toLocaleString('en-US')), el('td', {}, money(p.revenue))])));
      table.appendChild(tbody);
      topProductsCard.appendChild(table);
    }

    salesCard.innerHTML = '';
    salesCard.appendChild(el('h3', { style: 'margin-top:0;' }, 'Recent Sales'));
    if (salesTotal === 0) {
      salesCard.appendChild(el('div', { class: 'empty-state' }, 'No sales in this period yet.'));
    } else if (sales.length === 0 && salesPage > 1) {
      // Page went stale (e.g. a void/refund shrank the result set) — snap back to page 1.
      salesPage = 1;
      return load();
    } else {
      const table = el('table', {}, [el('thead', {}, el('tr', {}, ['Receipt #', 'Date', 'Cashier', 'Table', 'Customer', 'Total', 'Status', ''].map((h) => el('th', {}, h))))]);
      const tbody = el('tbody');
      sales.forEach((s) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, s.sale_number),
          el('td', {}, s.created_at),
          el('td', {}, s.cashier_name),
          el('td', {}, s.table_name || '—'),
          el('td', {}, s.customer_name || '—'),
          el('td', {}, money(s.total)),
          el('td', {}, el('span', { class: `badge ${s.status}` }, s.status.replace('_', ' '))),
          el('td', {}, [
            el('button', { class: 'btn small', onclick: () => openSaleDetailModal(s.id, load) }, 'View'),
          ]),
        ]));
      });
      table.appendChild(tbody);
      salesCard.appendChild(table);

      const totalPages = Math.max(1, Math.ceil(salesTotal / SALES_PAGE_SIZE));
      const rangeStart = (salesPage - 1) * SALES_PAGE_SIZE + 1;
      const rangeEnd = Math.min(salesTotal, salesPage * SALES_PAGE_SIZE);
      salesCard.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:12px;' }, [
        el('span', { style: 'color:var(--text-muted);font-size:13px;' }, `Showing ${rangeStart}-${rangeEnd} of ${salesTotal}`),
        el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [
          el('button', { class: 'btn small', disabled: salesPage <= 1 ? 'true' : null, onclick: () => { salesPage -= 1; load(); } }, 'Prev'),
          el('span', { style: 'font-size:13px;color:var(--text-muted);' }, `Page ${salesPage} of ${totalPages}`),
          el('button', { class: 'btn small', disabled: salesPage >= totalPages ? 'true' : null, onclick: () => { salesPage += 1; load(); } }, 'Next'),
        ]),
      ]));
    }
  }

  await load();

  const archiveYears = await api.get('/api/archive/years');
  const eligibleYears = archiveYears.liveYears.filter((y) => y.eligible).map((y) => y.year).sort((a, b) => a - b);
  if (eligibleYears.length > 0) {
    container.appendChild(el('div', { class: 'card', style: 'margin-bottom:16px;background:#fdf2e0;border-color:#f0d9a8;color:#4a3510;display:flex;justify-content:space-between;align-items:center;gap:12px;' }, [
      el('span', {}, [
        el('strong', {}, `⚠ ${eligibleYears.join(', ')} `),
        `${eligibleYears.length === 1 ? 'has' : 'have'} records eligible to archive — archiving keeps this Reports page fast without deleting anything.`,
      ]),
      el('button', { class: 'btn small', style: 'flex-shrink:0;background:#4a3510;border-color:#4a3510;color:#fdf2e0;', onclick: () => navigate('settings') }, 'Go to Settings'),
    ]));
  }

  container.appendChild(periodBar);
  container.appendChild(statsGrid);
  container.appendChild(topProductsCard);
  container.appendChild(salesCard);
}

// ---- Metrics tab: business trend charts ----

function formatHourLabel(hour) {
  const period = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${period}`;
}

function formatDayLabel(dayStr) {
  return new Date(`${dayStr}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatMonthLabel(d) {
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function toSqlDateTime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function formatCompactNumber(v) {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString('en-US');
}

function formatCompactMoney(v) {
  const sym = (window.APP_STATE && window.APP_STATE.settings) ? window.APP_STATE.settings.currency_symbol : '₱';
  return `${sym}${formatCompactNumber(v)}`;
}

// Monday of the UTC week containing d.
function weekStart(d) {
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  return monday;
}

// Collapses /api/reports/daily rows (one per day) into weekly or monthly
// buckets client-side — no backend change needed for the extra granularities.
function aggregateByGranularity(dailyRows, granularity) {
  if (granularity === 'daily') {
    return dailyRows.map((r) => ({ label: formatDayLabel(r.day), revenue: r.revenue || 0, orders: r.orders || 0 }));
  }
  const buckets = new Map();
  for (const r of dailyRows) {
    const d = new Date(`${r.day}T00:00:00Z`);
    const start = granularity === 'weekly' ? weekStart(d) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const key = start.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, { start, revenue: 0, orders: 0 });
    const b = buckets.get(key);
    b.revenue += r.revenue || 0;
    b.orders += r.orders || 0;
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.start - b.start)
    .map((b) => ({
      label: granularity === 'weekly' ? formatDayLabel(b.start.toISOString().slice(0, 10)) : formatMonthLabel(b.start),
      revenue: b.revenue,
      orders: b.orders,
    }));
}

function granularityHint(granularity) {
  return granularity === 'daily' ? 'Last 30 days' : granularity === 'weekly' ? 'Last 12 weeks' : 'Last 12 months';
}

async function renderMetricsTab(container) {
  let tab = 'sales';

  const tabButtons = el('div', { class: 'category-tabs' }, [
    el('button', { class: 'active', onclick: () => switchTab('sales') }, 'Sales'),
    el('button', { class: '', onclick: () => switchTab('customer') }, 'Customer'),
  ]);
  const tabBody = el('div');
  container.appendChild(tabButtons);
  container.appendChild(tabBody);

  function switchTab(t) {
    tab = t;
    tabButtons.querySelectorAll('button').forEach((b, idx) => b.classList.toggle('active', ['sales', 'customer'][idx] === t));
    renderTabBody();
  }
  function renderTabBody() {
    tabBody.innerHTML = '';
    if (tab === 'sales') renderSalesMetrics(tabBody);
    else renderCustomerMetrics(tabBody);
  }
  renderTabBody();
}

async function renderSalesMetrics(container) {
  let granularity = 'daily';

  const granLabels = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  const granTabs = el('div', { class: 'category-tabs' }, Object.keys(granLabels).map((g) =>
    el('button', { class: g === granularity ? 'active' : '', onclick: () => { granularity = g; loadTrends(); } }, granLabels[g])
  ));

  const hourlyCard = el('div', { class: 'card chart-card', style: 'margin-top:18px;margin-bottom:18px;' });
  const trendBar = el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:14px;' }, [
    el('span', { style: 'font-size:12.5px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em;' }, 'Sales Trend'),
    granTabs,
  ]);
  const revenueCard = el('div', { class: 'card chart-card', style: 'margin-bottom:18px;' });
  const ordersCard = el('div', { class: 'card chart-card', style: 'margin-bottom:18px;' });

  const channelsHeading = el('div', { style: 'margin-top:26px;margin-bottom:14px;' }, [
    el('span', { style: 'font-size:12.5px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em;' }, 'Order Channels'),
  ]);
  const channelStatsGrid = el('div', { class: 'stat-grid', style: 'margin-bottom:18px;' });
  const channelsCard = el('div', { class: 'card chart-card' });

  container.appendChild(hourlyCard);
  container.appendChild(trendBar);
  container.appendChild(revenueCard);
  container.appendChild(ordersCard);
  container.appendChild(channelsHeading);
  container.appendChild(channelStatsGrid);
  container.appendChild(channelsCard);

  async function loadHourly() {
    hourlyCard.innerHTML = '';
    hourlyCard.appendChild(el('h3', {}, 'Sales by Hour — Today'));
    hourlyCard.appendChild(el('div', { class: 'chart-sub' }, 'Revenue for each hour of today so far.'));
    const chartEl = el('div');
    hourlyCard.appendChild(chartEl);

    const rows = await api.get('/api/reports/hourly?period=today');
    const byHour = new Map(rows.map((r) => [Number(r.hour), r.revenue]));
    const points = Array.from({ length: 24 }, (_, h) => ({ label: formatHourLabel(h), value: byHour.get(h) || 0 }));

    renderTrendChart(chartEl, {
      points, color: '#f2541f',
      formatValue: (v) => money(v),
      formatTick: (v) => formatCompactMoney(v),
      emptyMessage: 'No sales recorded yet today.',
    });
  }

  async function loadTrends() {
    granTabs.querySelectorAll('button').forEach((b, idx) => b.classList.toggle('active', Object.keys(granLabels)[idx] === granularity));

    const spanDays = granularity === 'daily' ? 30 : granularity === 'weekly' ? 84 : 365;
    const to = new Date();
    const from = new Date(to.getTime() - spanDays * 86400000);
    const qs = `from=${encodeURIComponent(toSqlDateTime(from))}&to=${encodeURIComponent(toSqlDateTime(to))}`;
    const dailyRows = await api.get(`/api/reports/daily?${qs}`);
    const buckets = aggregateByGranularity(dailyRows, granularity);
    const hint = granularityHint(granularity);

    revenueCard.innerHTML = '';
    revenueCard.appendChild(el('h3', {}, 'Revenue Trend'));
    revenueCard.appendChild(el('div', { class: 'chart-sub' }, hint));
    const revChartEl = el('div');
    revenueCard.appendChild(revChartEl);
    renderTrendChart(revChartEl, {
      points: buckets.map((b) => ({ label: b.label, value: b.revenue })),
      color: '#f2541f',
      formatValue: (v) => money(v),
      formatTick: (v) => formatCompactMoney(v),
      emptyMessage: 'No sales recorded in this range yet.',
    });

    ordersCard.innerHTML = '';
    ordersCard.appendChild(el('h3', {}, 'Orders Trend'));
    ordersCard.appendChild(el('div', { class: 'chart-sub' }, hint));
    const ordChartEl = el('div');
    ordersCard.appendChild(ordChartEl);
    renderTrendChart(ordChartEl, {
      points: buckets.map((b) => ({ label: b.label, value: b.orders })),
      color: '#c98500',
      formatValue: (v) => `${Math.round(v).toLocaleString('en-US')} order${Math.round(v) === 1 ? '' : 's'}`,
      formatTick: (v) => formatCompactNumber(v),
      emptyMessage: 'No sales recorded in this range yet.',
    });
  }

  async function loadChannels() {
    const rows = await api.get('/api/reports/channels');
    const totalRevenue = rows.reduce((s, c) => s + c.revenue, 0);
    const totalCommission = rows.reduce((s, c) => s + c.commission_amount, 0);
    const totalNet = totalRevenue - totalCommission;

    channelStatsGrid.innerHTML = '';
    [
      ['All-Time Revenue', money(totalRevenue)],
      ['Commission Paid', money(totalCommission)],
      ['Net Revenue', money(totalNet)],
    ].forEach(([label, value]) => {
      channelStatsGrid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]));
    });

    channelsCard.innerHTML = '';
    channelsCard.appendChild(el('h3', {}, 'Revenue by Channel'));
    channelsCard.appendChild(el('div', { class: 'chart-sub' }, 'All-time gross revenue per channel — sublabel shows orders and commission rate.'));
    const channelsEl = el('div');
    channelsCard.appendChild(channelsEl);
    const sortedChannels = [...rows].sort((a, b) => b.revenue - a.revenue);
    renderBarList(channelsEl, {
      items: sortedChannels.map((c) => ({
        label: c.name,
        value: c.revenue,
        sublabel: `${c.order_count.toLocaleString('en-US')} order${c.order_count === 1 ? '' : 's'} · ${(c.commission_rate * 100).toFixed(0)}% commission`,
      })),
      color: '#199e70',
      formatValue: (v) => money(v),
      emptyMessage: 'No sales recorded yet.',
      nameLabel: 'Channel',
    });
  }

  await Promise.all([loadHourly(), loadTrends(), loadChannels()]);
}

async function renderCustomerMetrics(container) {
  const customerStatsGrid = el('div', { class: 'stat-grid', style: 'margin-top:18px;margin-bottom:18px;' });
  const topSpendersCard = el('div', { class: 'card chart-card', style: 'margin-bottom:18px;' });
  const recurringCard = el('div', { class: 'card chart-card', style: 'margin-bottom:18px;' });
  const consistentCard = el('div', { class: 'card chart-card' });

  container.appendChild(customerStatsGrid);
  container.appendChild(topSpendersCard);
  container.appendChild(recurringCard);
  container.appendChild(consistentCard);

  async function loadCustomers() {
    const rows = await api.get('/api/reports/customers');
    const totalCustomers = rows.length;
    const repeatCustomers = rows.filter((c) => c.order_count >= 2).length;
    const repeatRate = totalCustomers ? (repeatCustomers / totalCustomers) * 100 : 0;
    const totalSpent = rows.reduce((s, c) => s + c.total_spent, 0);
    const avgSpend = totalCustomers ? totalSpent / totalCustomers : 0;

    customerStatsGrid.innerHTML = '';
    [
      ['Customers with Orders', totalCustomers.toLocaleString('en-US')],
      ['Repeat Customers', repeatCustomers.toLocaleString('en-US')],
      ['Repeat Rate', `${repeatRate.toFixed(0)}%`],
      ['Avg. Spend / Customer', money(avgSpend)],
    ].forEach(([label, value]) => {
      customerStatsGrid.appendChild(el('div', { class: 'stat-card' }, [el('div', { class: 'label' }, label), el('div', { class: 'value' }, value)]));
    });

    topSpendersCard.innerHTML = '';
    topSpendersCard.appendChild(el('h3', {}, 'Top Spenders'));
    topSpendersCard.appendChild(el('div', { class: 'chart-sub' }, 'All-time revenue per customer — who has bought the most.'));
    const spendersEl = el('div');
    topSpendersCard.appendChild(spendersEl);
    const topSpenders = [...rows].sort((a, b) => b.total_spent - a.total_spent).slice(0, 10);
    renderBarList(spendersEl, {
      items: topSpenders.map((c) => ({ label: c.name, value: c.total_spent, sublabel: `${c.order_count} order${c.order_count === 1 ? '' : 's'}` })),
      color: '#f2541f',
      formatValue: (v) => money(v),
      emptyMessage: 'No customer purchases recorded yet.',
      nameLabel: 'Customer',
    });

    recurringCard.innerHTML = '';
    recurringCard.appendChild(el('h3', {}, 'Most Orders (Recurring)'));
    recurringCard.appendChild(el('div', { class: 'chart-sub' }, 'Customers with 2+ orders, ranked by total order count.'));
    const recurringEl = el('div');
    recurringCard.appendChild(recurringEl);
    const recurring = rows.filter((c) => c.order_count >= 2).sort((a, b) => b.order_count - a.order_count).slice(0, 10);
    renderBarList(recurringEl, {
      items: recurring.map((c) => ({ label: c.name, value: c.order_count, sublabel: money(c.total_spent) })),
      color: '#c98500',
      formatValue: (v) => `${Math.round(v).toLocaleString('en-US')} order${Math.round(v) === 1 ? '' : 's'}`,
      emptyMessage: 'No repeat customers yet.',
      nameLabel: 'Customer',
    });

    consistentCard.innerHTML = '';
    consistentCard.appendChild(el('h3', {}, 'Most Consistent'));
    consistentCard.appendChild(el('div', { class: 'chart-sub' }, "Customers with 3+ orders, ranked by distinct weeks they've ordered in — steady regulars, not just big spenders."));
    const consistentEl = el('div');
    consistentCard.appendChild(consistentEl);
    const consistent = rows.filter((c) => c.order_count >= 3).sort((a, b) => b.active_weeks - a.active_weeks || b.order_count - a.order_count).slice(0, 10);
    renderBarList(consistentEl, {
      items: consistent.map((c) => ({ label: c.name, value: c.active_weeks, sublabel: `${c.order_count} orders` })),
      color: '#3987e5',
      formatValue: (v) => `${Math.round(v)} week${Math.round(v) === 1 ? '' : 's'}`,
      emptyMessage: 'Not enough repeat activity yet.',
      nameLabel: 'Customer',
    });
  }

  await loadCustomers();
}

async function openSaleDetailModal(saleId, onDone) {
  const sale = await api.get(`/api/sales/${saleId}`);
  const backdrop = el('div', { class: 'modal-backdrop' });

  function refreshModal(freshSale) {
    backdrop.innerHTML = '';
    const canAct = freshSale.status === 'completed' || freshSale.status === 'partially_refunded';
    const modal = el('div', { class: 'modal', style: 'width:520px;' }, [
      el('h3', {}, `Sale ${freshSale.sale_number}`),
      el('div', { style: 'font-size:13px;color:var(--text-muted);margin-bottom:10px;' }, [
        `${freshSale.created_at} · Cashier: ${freshSale.cashier_name}`,
        freshSale.table_name ? ` · Table: ${freshSale.table_name}` : '',
        freshSale.customer_name ? ` · Customer: ${freshSale.customer_name}` : '',
      ]),
      el('span', { class: `badge ${freshSale.status}` }, freshSale.status.replace('_', ' ')),
      freshSale.discount_type && freshSale.discount_type !== 'none'
        ? el('div', { class: 'tag', style: 'margin-top:8px;display:inline-block;' }, `${freshSale.discount_type === 'senior' ? 'Senior Citizen' : 'PWD'} Discount — ${freshSale.discount_holder_name} (ID# ${freshSale.discount_id_number})`)
        : null,
      el('table', { style: 'margin-top:12px;' }, [
        el('thead', {}, el('tr', {}, ['Item', 'Qty', 'Refunded', 'Line Total'].map((h) => el('th', {}, h)))),
        el('tbody', {}, freshSale.items.map((i) => el('tr', {}, [
          el('td', {}, i.voided ? `${i.name} (removed, not charged)` : i.name),
          el('td', {}, String(i.qty)),
          el('td', {}, String(i.refunded_qty)),
          el('td', {}, i.voided ? '—' : money(i.line_total)),
        ]))),
      ]),
      freshSale.discount_total ? el('div', { class: 'totals-row' }, [el('span', {}, 'Discount'), el('span', {}, `-${money(freshSale.discount_total)}`)]) : null,
      freshSale.vat_exempt_total ? el('div', { class: 'totals-row' }, [el('span', {}, 'VAT-Exempt Sales'), el('span', {}, money(freshSale.vat_exempt_total))]) : null,
      el('div', { class: 'totals-row grand' }, [el('span', {}, 'Total'), el('span', {}, money(freshSale.total))]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', onclick: () => document.body.removeChild(backdrop) }, 'Close'),
        canAct ? el('button', { class: 'btn', onclick: () => openRefundModal(freshSale, (updated) => refreshModal(updated)) }, 'Refund Items') : null,
        freshSale.status === 'completed' ? el('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Void this entire sale? This restores stock and cannot be undone.')) return;
          try {
            const updated = await api.post(`/api/sales/${freshSale.id}/void`);
            toast('Sale voided', 'success');
            refreshModal(updated);
            onDone();
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Void Sale') : null,
      ].filter(Boolean)),
    ]);
    backdrop.appendChild(modal);
  }

  refreshModal(sale);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { document.body.removeChild(backdrop); onDone(); } });
}

function openRefundModal(sale, onDone) {
  const inner = el('div', { class: 'modal-backdrop' });
  const qtyInputs = {};
  const reasonInput = el('input', { type: 'text', placeholder: 'Reason (optional)' });
  const errorEl = el('div', { class: 'login-error' }, '');
  // Defaults to how the sale was actually paid — this feeds the shift's cash
  // reconciliation (computeShiftSummary only nets refunds tagged 'cash' out
  // of expected cash), so a refund on a GCash/card/Maya sale must not be
  // recorded as cash or it'll make the drawer look short at close-out.
  let method = (sale.payments && sale.payments[0] && sale.payments[0].method) || 'cash';

  const rows = sale.items.filter((i) => !i.voided && i.refunded_qty < i.qty).map((i) => {
    const remaining = i.qty - i.refunded_qty;
    const input = el('input', { type: 'number', min: '0', max: String(remaining), step: '1', value: '0', style: 'width:70px;' });
    qtyInputs[i.id] = input;
    return el('div', { class: 'totals-row' }, [el('span', {}, `${i.name} (max ${remaining})`), input]);
  });

  function renderModal() {
    inner.innerHTML = '';
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, 'Refund Items'),
      rows.length ? el('div', {}, rows) : el('div', { class: 'empty-state' }, 'All items already refunded.'),
      el('div', { class: 'field', style: 'margin-top:10px;' }, [
        el('label', {}, 'Refund Method — how the money is actually going back'),
        el('div', { class: 'tender-methods' }, ['cash', 'card', 'gcash', 'maya', 'other'].map((m) =>
          el('button', { class: method === m ? 'active' : '', onclick: () => { method = m; renderModal(); } }, m.toUpperCase())
        )),
      ]),
      el('div', { class: 'field' }, [el('label', {}, 'Reason'), reasonInput]),
      errorEl,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', onclick: () => document.body.removeChild(inner) }, 'Cancel'),
        el('button', { class: 'btn danger', onclick: async () => {
          const items = Object.entries(qtyInputs).filter(([, input]) => Number(input.value) > 0).map(([id, input]) => ({ sale_item_id: Number(id), qty: Number(input.value) }));
          if (items.length === 0) { errorEl.textContent = 'Enter a quantity to refund'; return; }
          try {
            const result = await api.post(`/api/sales/${sale.id}/refund`, { items, reason: reasonInput.value, method });
            toast('Refund processed', 'success');
            document.body.removeChild(inner);
            onDone(result.sale);
          } catch (e) { errorEl.textContent = e.message; }
        } }, 'Process Refund'),
      ]),
    ]);
    inner.appendChild(modal);
  }
  renderModal();
  document.body.appendChild(inner);
}
