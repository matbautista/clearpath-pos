function dateRange(period, from, to) {
  if (from && to) return { from, to };
  const now = new Date();
  const start = new Date(now);
  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    start.setDate(start.getDate() - 7);
  } else if (period === 'month') {
    start.setMonth(start.getMonth() - 1);
  } else if (period === 'year') {
    // Year-to-date: Jan 1 of the current year through now, not a rolling 365 days.
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0);
  }
  return { from: start.toISOString().slice(0, 19).replace('T', ' '), to: now.toISOString().slice(0, 19).replace('T', ' ') };
}

module.exports = { dateRange };
