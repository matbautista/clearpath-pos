// Lightweight, dependency-free area/line trend chart (SVG) shared by the
// Reports > Metrics tab. No charting library — everything here runs offline
// like the rest of the app.

function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const frac = value / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// points: [{ label, value }]
function renderTrendChart(container, { points, color, formatValue = String, formatTick = formatValue, height = 200, emptyMessage = 'No data for this period.' }) {
  container.innerHTML = '';
  if (!points || points.length === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, emptyMessage));
    return;
  }

  const W = 900, H = height;
  const padL = 50, padR = 14, padT = 16, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baselineY = padT + plotH;

  const niceMax = niceCeil(Math.max(...points.map((p) => p.value), 0) || 1);
  const xAt = (i) => (points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);
  const yAt = (v) => baselineY - (v / niceMax) * plotH;

  const coords = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`);
  const linePath = `M ${coords.join(' L ')}`;
  const areaPath = `M ${xAt(0).toFixed(1)},${baselineY} L ${coords.join(' L ')} L ${xAt(points.length - 1).toFixed(1)},${baselineY} Z`;

  const tickCount = 4;
  const ticks = Array.from({ length: tickCount }, (_, i) => (niceMax / (tickCount - 1)) * i);
  const gridLines = ticks.map((t) => {
    const y = yAt(t).toFixed(1);
    return `<line class="chart-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />`;
  }).join('');
  const tickLabels = ticks.map((t) => {
    const y = yAt(t).toFixed(1);
    return `<text class="chart-tick" x="${padL - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeXml(formatTick(t))}</text>`;
  }).join('');

  const maxLabels = 8;
  const step = Math.max(1, Math.ceil(points.length / maxLabels));
  const xLabels = points.map((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) return '';
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    return `<text class="chart-tick" x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${escapeXml(p.label)}</text>`;
  }).join('');

  const lastIdx = points.length - 1;
  const lastX = xAt(lastIdx);
  const lastY = yAt(points[lastIdx].value);
  const endAnchor = lastX > W - 90 ? 'end' : 'start';
  const endX = endAnchor === 'end' ? lastX - 10 : lastX + 10;

  container.innerHTML = `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" style="height:${H}px;">
        <g>${gridLines}</g>
        <path d="${areaPath}" fill="${color}" fill-opacity="0.12" stroke="none" />
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${color}" stroke="var(--panel)" stroke-width="2" />
        <text class="chart-end-label" x="${endX.toFixed(1)}" y="${(lastY - 10).toFixed(1)}" text-anchor="${endAnchor}">${escapeXml(formatValue(points[lastIdx].value))}</text>
        <g>${tickLabels}</g>
        <g>${xLabels}</g>
        <line class="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${baselineY}" opacity="0" />
        <circle class="chart-hover-dot" cx="0" cy="0" r="4" fill="${color}" stroke="var(--panel)" stroke-width="2" opacity="0" />
        <rect class="chart-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" tabindex="0" />
      </svg>
      <div class="chart-tooltip"></div>
    </div>
  `;

  const svg = container.querySelector('svg');
  const hitRect = svg.querySelector('.chart-hit');
  const crosshair = svg.querySelector('.chart-crosshair');
  const hoverDot = svg.querySelector('.chart-hover-dot');
  const tooltip = container.querySelector('.chart-tooltip');
  let focusedIdx = lastIdx;

  function showAt(i) {
    const idx = Math.max(0, Math.min(lastIdx, i));
    const p = points[idx];
    const x = xAt(idx), y = yAt(p.value);
    crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x); crosshair.setAttribute('opacity', '1');
    hoverDot.setAttribute('cx', x); hoverDot.setAttribute('cy', y); hoverDot.setAttribute('opacity', '1');

    tooltip.innerHTML = '';
    const labelEl = document.createElement('div');
    labelEl.className = 'chart-tooltip-label';
    labelEl.textContent = p.label;
    const valueEl = document.createElement('div');
    valueEl.className = 'chart-tooltip-value';
    valueEl.textContent = formatValue(p.value);
    tooltip.appendChild(labelEl);
    tooltip.appendChild(valueEl);

    const pct = x / W;
    tooltip.style.opacity = '1';
    tooltip.style.left = `${pct * 100}%`;
    tooltip.style.transform = `translate(${pct > 0.8 ? '-100%' : pct < 0.08 ? '0%' : '-50%'}, -100%)`;
    return idx;
  }
  function hide() {
    crosshair.setAttribute('opacity', '0');
    hoverDot.setAttribute('opacity', '0');
    tooltip.style.opacity = '0';
  }

  hitRect.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    focusedIdx = showAt(Math.round(((relX - padL) / plotW) * lastIdx));
  });
  hitRect.addEventListener('pointerleave', hide);
  hitRect.addEventListener('focus', () => { focusedIdx = showAt(lastIdx); });
  hitRect.addEventListener('blur', hide);
  hitRect.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { focusedIdx = showAt(focusedIdx - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { focusedIdx = showAt(focusedIdx + 1); e.preventDefault(); }
  });

  // Every value the tooltip shows must also be reachable without hovering.
  const details = el('details', { style: 'margin-top:8px;' }, [
    el('summary', { style: 'cursor:pointer;font-size:12px;color:var(--text-muted);' }, 'View as table'),
    el('table', { style: 'margin-top:8px;' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, ''), el('th', {}, 'Value')])),
      el('tbody', {}, points.map((p) => el('tr', {}, [el('td', {}, p.label), el('td', {}, formatValue(p.value))]))),
    ]),
  ]);
  container.appendChild(details);
}

// Ranked horizontal bar list — for "compare magnitude across many named
// entities" (top spenders, most orders, etc.), where a trend/line chart
// doesn't apply because there's no time axis, just a ranking.
// items: [{ label, value, sublabel? }]
function renderBarList(container, { items, color, formatValue = String, emptyMessage = 'No data yet.', nameLabel = 'Name' }) {
  container.innerHTML = '';
  if (!items || items.length === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, emptyMessage));
    return;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  const list = el('div', { class: 'bar-list' });
  items.forEach((item, idx) => {
    const pct = Math.max(3, (item.value / max) * 100);
    list.appendChild(el('div', { class: 'bar-list-row' }, [
      el('div', { class: 'bar-list-rank' }, String(idx + 1)),
      el('div', { class: 'bar-list-name' }, [
        el('div', { class: 'bar-list-label' }, item.label),
        item.sublabel ? el('div', { class: 'bar-list-sublabel' }, item.sublabel) : null,
      ].filter(Boolean)),
      el('div', { class: 'bar-list-track' }, [
        el('div', { class: 'bar-list-fill', style: `width:${pct}%;background:${color};` }),
      ]),
      el('div', { class: 'bar-list-value' }, formatValue(item.value)),
    ]));
  });
  container.appendChild(list);

  const details = el('details', { style: 'margin-top:10px;' }, [
    el('summary', { style: 'cursor:pointer;font-size:12px;color:var(--text-muted);' }, 'View as table'),
    el('table', { style: 'margin-top:8px;' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, nameLabel), el('th', {}, 'Value')])),
      el('tbody', {}, items.map((i) => el('tr', {}, [el('td', {}, i.label), el('td', {}, formatValue(i.value))]))),
    ]),
  ]);
  container.appendChild(details);
}
