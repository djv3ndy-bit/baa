let client;
let session;
let dataCache = {};

const fmt = new Intl.NumberFormat();
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const pct = (value, total) => total ? Math.round(Number(value || 0) / Number(total) * 100) : 0;
const growth = (current, previous) => previous ? `${Math.round((current - previous) / previous * 100) > 0 ? '+' : ''}${Math.round((current - previous) / previous * 100)}%` : current ? '+100%' : '0%';
const shortDate = (value) => value ? new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const colors = ['#b76022', '#287443', '#7657c8', '#287fb8', '#d6a21f', '#d14f68', '#2f9f93', '#8b6a55'];

const pages = {
  overview: { title: 'Owner Overview', heading: 'Your business at a glance', description: 'The most important platform signals and quick links to every report.' },
  growth: { title: 'Growth & Marketing', heading: 'Growth and acquisition', description: 'Understand traffic, signup conversion, channels, and weekly momentum.' },
  subscriptions: { title: 'Subscriptions & Revenue', heading: 'Subscriptions and revenue', description: 'Monitor trials, partner access, paid accounts, and confirmed collections.' },
  marketplace: { title: 'Marketplace Health', heading: 'Marketplace and engagement', description: 'Track jobs, interest, matches, messaging, and marketplace conversion.' },
  audience: { title: 'Audience Insights', heading: 'Audience and member insights', description: 'Review member mix, devices, and optional private demographic totals.' },
  reliability: { title: 'Reliability Office', heading: 'Engineering and reliability', description: 'Monitor the agent, review incidents, and open owner-approved response tools.' },
};

const navigation = [
  ['overview', '/owner-dashboard', '⌂', 'Overview'],
  ['growth', '/owner-growth', '↗', 'Growth'],
  ['subscriptions', '/owner-subscriptions', '$', 'Subscriptions'],
  ['marketplace', '/owner-marketplace', '⇄', 'Marketplace'],
  ['audience', '/owner-audience', '◉', 'Audience'],
];

const operationsNavigation = [
  ['reliability', '/owner-reliability', '◆', 'Reliability office'],
  ['support', '/support-admin', '?', 'Support desk'],
  ['platform', '/dashboard', '☕', 'Platform'],
];

function mountShell(page) {
  const meta = pages[page] || pages.overview;
  document.title = `${meta.title} — BaristaMatch`;
  document.getElementById('owner-app').innerHTML = `<div class="owner-shell">
    <aside class="owner-side" aria-label="Owner navigation">
      <a class="owner-brand" href="/owner-dashboard"><img src="/assets/favicon-32-v2.png" alt=""><span>BaristaMatch</span></a>
      <div class="nav-label">Analytics</div>
      <nav class="owner-nav">${navigation.map(([key, href, icon, label]) => `<a class="${page === key ? 'active' : ''}" href="${href}" ${page === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav>
      <div class="nav-label">Operations</div>
      <nav class="owner-nav">${operationsNavigation.map(([key, href, icon, label]) => `<a class="${page === key ? 'active' : ''}" href="${href}" ${page === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav>
    </aside>
    <button class="mobile-backdrop" id="mobile-backdrop" aria-label="Close menu"></button>
    <main class="owner-main">
      <header class="owner-top"><div style="display:flex;align-items:center;gap:12px"><button class="mobile-menu" id="mobile-menu" aria-label="Open menu">☰</button><h1>${esc(meta.title)}</h1></div><div class="top-actions"><button class="top-button" id="refresh">Refresh</button><button class="top-button" id="logout">Log out</button></div></header>
      <div class="owner-content"><div class="page-intro"><div><h2>${esc(meta.heading)}</h2><p>${esc(meta.description)}</p></div><div class="fresh" id="fresh"></div></div><div id="view" class="loading">Loading private analytics…</div></div>
    </main>
  </div>`;
  document.getElementById('mobile-menu').onclick = () => document.body.classList.toggle('menu-open');
  document.getElementById('mobile-backdrop').onclick = () => document.body.classList.remove('menu-open');
  document.getElementById('refresh').onclick = () => load();
  document.getElementById('logout').onclick = logout;
  document.getElementById('view').onclick = (event) => {
    const button = event.target.closest('[data-partner-id]');
    if (button) updatePartnerAccess(button);
  };
}

function metric(label, value, note = 'All time', tone = '') {
  const shown = typeof value === 'number' ? fmt.format(value || 0) : esc(value || '0');
  return `<article class="card metric ${tone}"><span class="metric-label">${esc(label)}</span><strong>${shown}</strong><small>${esc(note)}</small></article>`;
}

function sectionHead(title, description = '') {
  return `<div class="section-head"><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div></div>`;
}

function quickCard(href, icon, title, description, action) {
  return `<a class="card quick-card" href="${href}"><span class="quick-icon" aria-hidden="true">${icon}</span><h3>${esc(title)}</h3><p>${esc(description)}</p><b>${esc(action)} →</b></a>`;
}

function dateLabel(row) {
  const value = row.week_start || row.date || row.metric_date;
  if (!value) return '';
  return new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function lineChart(title, rows, series, description = 'Last 8 weeks') {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return `<article class="card chart-card"><div class="chart-title"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div></div><div class="empty">No trend data yet.</div></article>`;
  const width = 720, height = 250, left = 42, right = 14, top = 18, bottom = 34;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const allValues = safeRows.flatMap((row) => series.map((item) => Number(row[item.key]) || 0));
  const max = Math.max(1, ...allValues);
  const x = (index) => left + (safeRows.length === 1 ? plotWidth / 2 : index / (safeRows.length - 1) * plotWidth);
  const y = (value) => top + plotHeight - (Number(value) || 0) / max * plotHeight;
  const grid = [0, .25, .5, .75, 1].map((ratio) => `<line class="chart-grid-line" x1="${left}" y1="${top + plotHeight * ratio}" x2="${width - right}" y2="${top + plotHeight * ratio}"></line><text class="chart-axis-label" x="${left - 8}" y="${top + plotHeight * ratio + 3}" text-anchor="end">${fmt.format(Math.round(max * (1 - ratio)))}</text>`).join('');
  const paths = series.map((item, seriesIndex) => {
    const color = item.color || colors[seriesIndex % colors.length];
    const points = safeRows.map((row, index) => `${x(index)},${y(row[item.key])}`).join(' ');
    const dots = safeRows.map((row, index) => `<circle class="chart-point" cx="${x(index)}" cy="${y(row[item.key])}" r="4" fill="${color}"><title>${esc(item.label)} · ${dateLabel(row)} · ${fmt.format(Number(row[item.key]) || 0)}</title></circle>`).join('');
    return `<polyline class="chart-line" points="${points}" stroke="${color}"></polyline>${dots}`;
  }).join('');
  const labelIndexes = [...new Set([0, Math.floor((safeRows.length - 1) / 2), safeRows.length - 1])];
  const labels = labelIndexes.map((index) => `<text class="chart-axis-label" x="${x(index)}" y="${height - 8}" text-anchor="middle">${esc(dateLabel(safeRows[index]))}</text>`).join('');
  return `<article class="card chart-card"><div class="chart-title"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div><div class="chart-legend">${series.map((item, index) => `<span><i class="legend-dot" style="background:${item.color || colors[index % colors.length]}"></i>${esc(item.label)}</span>`).join('')}</div></div><svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)} chart">${grid}${paths}${labels}</svg></article>`;
}

function barChart(title, rows, valueKey = 'value', description = '', formatter = (value) => fmt.format(value)) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const max = Math.max(1, ...safeRows.map((row) => Number(row[valueKey]) || 0));
  return `<article class="card chart-card"><div class="chart-title"><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div></div>${safeRows.length ? `<div class="bar-chart">${safeRows.map((row, index) => { const value = Number(row[valueKey]) || 0; return `<div class="bar-column" title="${esc(row.label || dateLabel(row))}: ${esc(formatter(value))}"><span class="bar-value">${esc(formatter(value))}</span><div class="bar-block" style="height:${Math.max(value ? 4 : 1, value / max * 82)}%;background:${colors[index % colors.length]}"></div><span class="bar-label">${esc(row.label || dateLabel(row))}</span></div>`; }).join('')}</div>` : '<div class="empty">No data yet.</div>'}</article>`;
}

function ranking(title, rows, color = '#b76022', description = '') {
  const safeRows = Array.isArray(rows) ? rows : [];
  const max = Math.max(1, ...safeRows.map((row) => Number(row.value) || 0));
  return `<article class="card chart-card"><div class="chart-title"><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div></div><div class="ranking-list">${safeRows.length ? safeRows.map((row) => `<div class="ranking-row"><div><div class="ranking-label">${esc(row.label)}</div><div class="track"><div class="fill" style="width:${Math.max(row.value ? 3 : 0, row.value / max * 100)}%;background:${color}"></div></div></div><strong>${fmt.format(row.value || 0)}</strong></div>`).join('') : '<div class="empty">No data yet.</div>'}</div></article>`;
}

function donutChart(title, rows, description = '') {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => Number(row.value) > 0);
  const total = safeRows.reduce((sum, row) => sum + Number(row.value || 0), 0);
  let cursor = 0;
  const stops = safeRows.map((row, index) => { const start = cursor; cursor += Number(row.value) / Math.max(1, total) * 360; return `${colors[index % colors.length]} ${start}deg ${cursor}deg`; }).join(',');
  return `<article class="card chart-card"><div class="chart-title"><div><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ''}</div></div><div class="donut-layout"><div class="donut" style="background:${total ? `conic-gradient(${stops})` : '#eee5dd'}"><div class="donut-center"><strong>${fmt.format(total)}</strong><span>Total</span></div></div><div class="donut-legend">${safeRows.length ? safeRows.map((row, index) => `<div class="donut-row"><i style="background:${colors[index % colors.length]}"></i><span>${esc(row.label)}</span><strong>${fmt.format(row.value)} · ${pct(row.value, total)}%</strong></div>`).join('') : '<div class="empty">No data yet.</div>'}</div></div></article>`;
}

function funnelRow(label, value, max, color) {
  return `<div class="funnel-row"><strong>${esc(label)}</strong><div class="funnel-track"><div class="funnel-fill" style="width:${Math.max(value ? 4 : 0, value / Math.max(1, max) * 100)}%;background:${color}"></div></div><b>${fmt.format(value)}</b></div>`;
}

function insight(label, value, note) {
  return `<article class="card insight"><small>${esc(label)}</small><strong>${esc(value)}</strong><p>${esc(note)}</p></article>`;
}

function statusRows(accounts) {
  const counts = new Map();
  (accounts || []).forEach((account) => counts.set(account.status || 'unknown', (counts.get(account.status || 'unknown') || 0) + 1));
  return [...counts].map(([status, value]) => ({ label: status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()), value }));
}

function subscriptionAccounts(rows) {
  return `<article class="card account-table"><table><thead><tr><th>Café</th><th>Location</th><th>Status</th><th>Trial ends</th><th>Monthly value</th><th>Current access</th></tr></thead><tbody>${rows.length ? rows.map((row) => { const statusClass = String(row.status || '').replace(/[^a-z_]/gi, ''); return `<tr><td><strong>${esc(row.name)}</strong><span class="partner-badge">✓ Complimentary</span></td><td>${esc(row.location)}</td><td><span class="status-pill ${statusClass}">${esc(row.status)}</span></td><td>${shortDate(row.trial_ends_at)}</td><td><strong>$0.00</strong></td><td><span class="partner-badge">Billing paused</span></td></tr>`; }).join('') : '<tr><td colspan="6">No café access accounts yet.</td></tr>'}</tbody></table></article>`;
}

const renderers = {};

renderers.overview = (data) => {
  const m = data.metrics || {}, s = data.subscriptions || { metrics: {} }, sm = s.metrics || {};
  const interest = Number(m.applications || 0) + Number(m.interests || 0), matchRate = pct(m.matches, interest), signupRate = pct(m.signups, m.website_30d);
  return `<section class="hero-strip"><article class="card hero-copy"><small>Private owner workspace</small><h3>Everything important, without the long scroll.</h3><p>Use this page for a quick health check, then open a focused report for growth, revenue, marketplace activity, or audience insights.</p></article><article class="card hero-callout"><span>Marketplace conversion</span><strong>${matchRate}%</strong><p>${fmt.format(m.matches || 0)} matches from ${fmt.format(interest)} interest signals</p></article></section>
  ${sectionHead('Platform pulse', 'Highest-signal measures across the business')}
  <section class="metrics">${metric('Total members', m.signups, `${m.signups_7d || 0} joined this week`, 'orange')}${metric('Website · 7 days', m.website_7d, `${growth(m.website_7d || 0, m.website_prev_7d || 0)} versus prior week`, 'blue')}${metric('Mutual matches', m.matches, `${matchRate}% interest-to-match`, 'purple')}${metric('Monthly recurring revenue', money(sm.mrr_cents), 'Projected from active paid plans', 'green')}</section>
  ${sectionHead('Open a focused report', 'Each section has its own page, charts, and supporting detail')}
  <section class="quick-grid">${quickCard('/owner-growth', '↗', 'Growth & marketing', 'Traffic, signup conversion, channels, pages, and acquisition trends.', 'View growth')}${quickCard('/owner-subscriptions', '$', 'Subscriptions', 'Trials, paid cafés, partner access, revenue, and account controls.', 'View subscriptions')}${quickCard('/owner-marketplace', '⇄', 'Marketplace', 'Jobs, applications, profile interest, matches, and conversations.', 'View marketplace')}${quickCard('/owner-audience', '◉', 'Audience', 'Member roles, devices, demographic totals, and data completion.', 'View audience')}${quickCard('/owner-reliability', '◆', 'Reliability office', 'Live website checks, agent runs, alert readiness, and safe response links.', 'Manage reliability')}</section>
  ${sectionHead('Weekly momentum', 'A shared view of acquisition and marketplace outcomes')}
  ${lineChart('Platform momentum', data.weekly, [{ key: 'website_views', label: 'Website views', color: '#e86b24' }, { key: 'signups', label: 'Signups', color: '#2d8b57' }, { key: 'matches', label: 'Matches', color: '#7657c8' }])}
  ${sectionHead('Action queue')}
  <section class="metrics">${metric('Complimentary cafés', sm.complimentary, 'Billing paused · full access', 'gold')}${metric('Past due', sm.past_due, 'Legacy billing records', 'red')}${metric('Open support', m.support_open, 'Needs a response', 'blue')}${metric('Discoverable profiles', m.discoverable, 'Ready to match', 'teal')}</section>
  <article class="privacy-note"><strong>Metric definitions:</strong> Website conversion compares total members with recent 30-day page views and is directional, not cohort-based. Revenue stays at $0 until a successful payment is recorded. All pages use the same protected owner analytics response, so figures reconcile across reports.</article>`;
};

renderers.growth = (data) => {
  const m = data.metrics || {}, signupRate = pct(m.signups, m.website_30d);
  return `<section class="insights">${insight('Website growth', growth(m.website_7d || 0, m.website_prev_7d || 0), `${fmt.format(m.website_7d || 0)} views this week versus ${fmt.format(m.website_prev_7d || 0)} last week`)}${insight('Visitor → signup', `${signupRate}%`, `${fmt.format(m.signups || 0)} total members from ${fmt.format(m.website_30d || 0)} recent views`)}${insight('New-member growth', growth(m.signups_7d || 0, m.signups_prev_7d || 0), `${fmt.format(m.signups_7d || 0)} joined this week`)}</section>
  ${sectionHead('Acquisition snapshot')}
  <section class="metrics">${metric('Website · 7 days', m.website_7d, 'Anonymous page views', 'orange')}${metric('Website · 30 days', m.website_30d, 'Anonymous page views', 'blue')}${metric('App · 30 days', m.app_30d, 'Authenticated screen activity', 'purple')}${metric('Total signups', m.signups, `${m.signups_7d || 0} this week`, 'green')}</section>
  ${sectionHead('Weekly acquisition trend', 'Compare website attention, app usage, and member growth')}
  ${lineChart('Acquisition over time', data.weekly, [{ key: 'website_views', label: 'Website views', color: '#e86b24' }, { key: 'app_views', label: 'App activity', color: '#287fb8' }, { key: 'signups', label: 'New signups', color: '#2d8b57' }])}
  ${sectionHead('Where visitors come from')}
  <section class="two-col">${ranking('Traffic sources · website', data.referrers, '#b27a1d', 'Last 30 days')}${ranking('Top website pages', data.top_pages, '#e86b24', 'Last 30 days')}</section>
  ${sectionHead('Product reach')}
  <section class="equal-col">${ranking('Top app screens', data.app_screens, '#287fb8', 'Last 30 days')}${donutChart('Website and app devices', data.devices, 'Last 30 days')}</section>`;
};

renderers.subscriptions = (data) => {
  const s = data.subscriptions || { metrics: {}, accounts: [], weekly_revenue: [] }, sm = s.metrics || {}, accounts = s.accounts || [];
  return `<div class="finance-note"><strong>Payments are paused:</strong> Café accounts currently have complimentary access, checkout is disabled, and no new charges can start.</div>
  ${sectionHead('Subscription snapshot')}
  <section class="metrics">${metric('Free trials', sm.trialing, `${sm.trials_ending_30d || 0} ending in 30 days`, 'gold')}${metric('Free partners', sm.complimentary, 'Owner-granted access', 'green')}${metric('Paying cafés', sm.active_paid, s.processor_connected ? 'Billing connected' : 'Stripe not connected', 'purple')}${metric('Past due', sm.past_due, 'Payment needs attention', 'red')}${metric('Monthly recurring revenue', money(sm.mrr_cents), 'Projected from active paid plans', 'orange')}${metric('Annual run rate', money(sm.arr_cents), 'Projected MRR × 12', 'blue')}${metric('Confirmed collected', money(sm.collected_cents), 'Successful payments only', 'green')}${metric('Refunded', money(sm.refunded_cents), 'Recorded refunds', 'teal')}</section>
  ${sectionHead('Revenue and account mix')}
  <section class="equal-col">${barChart('Confirmed weekly collections', s.weekly_revenue, 'collected_cents', 'Last 8 weeks', money)}${donutChart('Subscription status', statusRows(accounts), 'Current café accounts')}</section>
  ${sectionHead('Café access accounts', 'Complimentary access remains enabled while payments are paused')}
  ${subscriptionAccounts(accounts)}`;
};

renderers.marketplace = (data) => {
  const m = data.metrics || {}, interest = Number(m.applications || 0) + Number(m.interests || 0), matchRate = pct(m.matches, interest), messagesPerMatch = m.matches ? Math.round(m.messages / m.matches * 10) / 10 : 0, funnelMax = Math.max(1, m.signups || 0, interest, m.matches || 0);
  return `${sectionHead('Marketplace snapshot')}
  <section class="metrics">${metric('Active jobs', m.active_jobs, `${m.jobs || 0} total jobs`, 'orange')}${metric('Interest signals', interest, `${m.applications || 0} applications · ${m.interests || 0} profile interests`, 'gold')}${metric('Mutual matches', m.matches, `${matchRate}% of interest signals`, 'purple')}${metric('Messages', m.messages, `${m.messages_7d || 0} this week`, 'blue')}${metric('Messages per match', messagesPerMatch, 'Conversation depth', 'green')}${metric('Discoverable profiles', m.discoverable, 'Ready to match', 'teal')}${metric('Notifications sent', m.notifications, 'All time', 'orange')}${metric('Open support', m.support_open, 'Member friction signal', 'red')}</section>
  ${sectionHead('Weekly marketplace activity', 'Supply, successful connections, and conversation depth')}
  ${lineChart('Marketplace momentum', data.weekly, [{ key: 'jobs', label: 'Jobs posted', color: '#d6a21f' }, { key: 'matches', label: 'Matches', color: '#d14f68' }, { key: 'messages', label: 'Messages', color: '#7657c8' }])}
  ${sectionHead('Marketplace conversion')}
  <article class="card funnel">${funnelRow('Members', m.signups || 0, funnelMax, 'linear-gradient(90deg,#2d8b57,#7bc999)')}${funnelRow('Interest signals', interest, funnelMax, 'linear-gradient(90deg,#d6a21f,#efd16b)')}${funnelRow('Mutual matches', m.matches || 0, funnelMax, 'linear-gradient(90deg,#d14f68,#ec8da0)')}${funnelRow('Active jobs', m.active_jobs || 0, funnelMax, 'linear-gradient(90deg,#287fb8,#83bada)')}</article>
  ${sectionHead('Marketplace mix')}
  <section class="equal-col">${donutChart('Job status', data.job_mix, 'Current job inventory')}${ranking('Support status', data.support_mix, '#d14f68', 'Operational member issues')}</section>`;
};

renderers.audience = (data) => {
  const d = data.demographics || { metrics: {}, age_ranges: [], gender_mix: [], completion_by_role: [] }, dm = d.metrics || {}, completion = pct(dm.profiles_with_demographics, dm.members);
  return `<section class="hero-strip"><article class="card hero-copy"><small>Audience intelligence</small><h3>Know who the platform serves.</h3><p>Role, device, age-range, and gender totals help guide marketing and product decisions. Optional demographics stay private and never appear on member profiles or hiring screens.</p></article><article class="card hero-callout"><span>Demographic participation</span><strong>${completion}%</strong><p>${fmt.format(dm.profiles_with_demographics || 0)} of ${fmt.format(dm.members || 0)} members shared at least one optional answer</p></article></section>
  ${sectionHead('Member snapshot')}
  <section class="metrics">${metric('Members', dm.members, 'All accounts', 'orange')}${metric('Demographics started', dm.profiles_with_demographics, 'At least one optional answer', 'green')}${metric('Age provided', dm.age_provided, 'Excludes “prefer not to say”', 'blue')}${metric('Gender provided', dm.gender_provided, 'Excludes “prefer not to say”', 'purple')}</section>
  ${sectionHead('Optional demographic totals', 'Private aggregate reporting only')}
  <section class="equal-col">${barChart('Age ranges', d.age_ranges, 'value', 'Includes not provided and prefer not to say')}${donutChart('Gender', d.gender_mix, 'Includes not provided and prefer not to say')}</section>
  ${sectionHead('Audience composition')}
  <section class="equal-col">${donutChart('Member roles', data.role_mix, 'All members')}${donutChart('Device mix', data.devices, 'Website and app activity · last 30 days')}</section>
  ${sectionHead('Data completion by role')}
  ${ranking('Members sharing optional demographics', d.completion_by_role, '#287443', 'At least one optional answer')}
  <article class="privacy-note"><strong>Privacy and appropriate use:</strong> Age range and gender are optional, stored separately from public profiles, and reported only as platform totals. They must not be used to screen, rank, or make employment decisions about an individual member.</article>`;
};

function relativeTime(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'Unavailable';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function timeLabel(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unavailable';
}

function durationLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function officePill(status, label = '') {
  const allowed = ['healthy', 'running', 'review', 'down', 'inactive', 'unavailable', 'overdue'];
  const tone = allowed.includes(status) ? status : 'unavailable';
  const shown = label || ({ healthy: 'Healthy', running: 'Running', review: 'Review', down: 'Down', inactive: 'Inactive', unavailable: 'Unavailable', overdue: 'Overdue' }[tone]);
  return `<span class="office-pill ${tone}">${esc(shown)}</span>`;
}

function integrationCard(item) {
  const icons = { website: '◎', public_config: '{}', github_actions: '⌘', private_providers: '◇', owner_email: '✉', deployment_verification: '✓' };
  const detail = item.latency_ms != null ? `${item.detail} · ${fmt.format(item.latency_ms)} ms` : item.detail;
  return `<article class="card integration-card"><div class="integration-top"><div class="integration-name"><span class="integration-icon" aria-hidden="true">${esc(icons[item.id] || '•')}</span>${esc(item.label)}</div>${officePill(item.status)}</div><p>${esc(detail)}</p><small>Read-only status · no provider write access</small></article>`;
}

function officeAction(href, icon, title, description, action) {
  return `<a class="card office-action" href="${href}" target="_blank" rel="noopener noreferrer"><span class="office-action-icon" aria-hidden="true">${icon}</span><h4>${esc(title)}</h4><p>${esc(description)}</p><b>${esc(action)} →</b></a>`;
}

function runOutcome(run) {
  if (run.status !== 'completed') return officePill('running', 'Running');
  if (run.conclusion === 'success') return officePill('healthy', 'P3 · Healthy');
  if (run.conclusion === 'cancelled') return officePill('overdue', 'Cancelled');
  return officePill('review', 'P0–P2 · Review');
}

renderers.reliability = (data) => {
  const status = data.status || { status: 'data_unavailable', severity: 'Unavailable', label: 'Reliability data unavailable' };
  const statusClass = ['healthy', 'running', 'review_required', 'overdue', 'data_unavailable'].includes(status.status) ? status.status : 'data_unavailable';
  const latest = data.latest_run || {};
  const metrics = data.metrics || {};
  const integrations = Array.isArray(data.integrations) ? data.integrations : [];
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const policy = data.policy || {};
  const successRate = metrics.success_rate == null ? '—' : `${metrics.success_rate}%`;
  const latestRunLabel = latest.number ? `Run #${fmt.format(latest.number)}` : 'Unavailable';
  const latestRunHref = latest.url || 'https://github.com/djv3ndy-bit/baa/actions/workflows/engineering-reliability-monitor.yml';
  return `<section class="reliability-hero"><article class="card agent-status ${statusClass}"><div class="status-kicker"><span class="status-light"></span>Engineering & Reliability Agent</div><h3>${esc(status.severity)} · ${esc(status.label)}</h3><p>The office combines the hourly GitHub monitor with fresh website and public API checks. Failed workflows are marked for review without guessing an unsupported exact severity.</p><div class="status-meta"><span>${esc(latestRunLabel)}</span><span>${esc(latest.event || 'No recent trigger')}</span><span>Model-free monitoring</span><span>No production writes</span></div></article><article class="card next-check"><div><small>Next scheduled check</small><strong>${esc(timeLabel(data.next_scheduled_check_at))}</strong><p>Runs hourly at minute 17 UTC and after every approved push to main.</p></div><a class="run-link" href="${latestRunHref}" target="_blank" rel="noopener noreferrer">Open latest run →</a></article></section>
  <section class="office-metrics"><article class="card office-metric"><span>Latest run</span><strong>${esc(latestRunLabel)}</strong><small>${esc(relativeTime(latest.started_at))}</small></article><article class="card office-metric"><span>Recent success rate</span><strong>${esc(successRate)}</strong><small>${fmt.format(metrics.successful_runs || 0)} of ${fmt.format(metrics.runs_reviewed || 0)} completed runs</small></article><article class="card office-metric"><span>Consecutive failures</span><strong>${fmt.format(metrics.consecutive_failures || 0)}</strong><small>Completed runs requiring review</small></article><article class="card office-metric"><span>Incident email</span><strong>P0 / P1</strong><small>Owner-approved alert channel only</small></article></section>
  ${sectionHead('System checks', 'Live probes and the latest completed workflow steps')}
  <section class="integration-grid">${integrations.map(integrationCard).join('')}</section>
  ${sectionHead('Owner controls', 'Every action opens its official review surface; this office has no deployment or provider-write credential')}
  <section class="office-actions">${officeAction('https://github.com/djv3ndy-bit/baa/actions/workflows/engineering-reliability-monitor.yml', '▶', 'Run or inspect monitor', 'Start a manual read-only check or review scheduled runs in GitHub Actions.', 'Open workflow')}${officeAction(latestRunHref, '⌕', 'Investigate latest run', 'Review the job summary, sanitized evidence artifact, and failed steps.', 'Open run')}${officeAction('https://github.com/djv3ndy-bit/baa/pulls', '↗', 'Review prepared fixes', 'Approve or reject agent-created pull requests before anything reaches main.', 'Open pull requests')}${officeAction('https://github.com/djv3ndy-bit/baa/settings/secrets/actions', '⚙', 'Agent configuration', 'Manage repository secrets and approval variables. Credential changes remain owner-only.', 'Open settings')}${officeAction('https://vercel.com/dashboard', '▲', 'Vercel deployments', 'Inspect production and preview deployments. Promotion remains owner-only.', 'Open Vercel')}${officeAction('https://supabase.com/dashboard/projects', '⚡', 'Supabase status', 'Inspect provider logs with your account. Database and security changes stay blocked.', 'Open Supabase')}${officeAction('https://resend.com/emails', '✉', 'Alert delivery', 'Review operational email delivery without exposing the API credential.', 'Open Resend')}${officeAction('https://platform.openai.com/settings/organization/usage', 'AI', 'OpenAI usage', 'Review optional analysis spending. Recurring health monitoring remains model-free.', 'Open usage')}</section>
  ${sectionHead('Recent monitor runs', 'Workflow results on main; exact P0/P1/P2 detail stays in the sanitized run artifact')}
  <article class="card run-table">${runs.length ? `<table><thead><tr><th>Run</th><th>Status</th><th>Trigger</th><th>Commit</th><th>Started</th><th>Duration</th></tr></thead><tbody>${runs.map((run) => `<tr><td><a class="run-link run-title" href="${run.url}" target="_blank" rel="noopener noreferrer">#${fmt.format(run.number || 0)} · ${esc(run.title)}</a></td><td>${runOutcome(run)}</td><td>${esc(run.event || 'Unknown')}</td><td><span class="sha">${esc(run.sha || '—')}</span></td><td>${esc(timeLabel(run.started_at))}</td><td>${esc(durationLabel(run.duration_seconds))}</td></tr>`).join('')}</tbody></table>` : '<div class="office-empty">No workflow history is available.</div>'}</article>
  ${sectionHead('Incident response path', 'The agent prepares evidence and reviewable work; the owner controls merge and production')}
  <section class="response-flow"><article class="card flow-step"><span class="flow-number">1</span><h4>Detect</h4><p>Check website, APIs, deployments, GitHub, and private providers.</p></article><article class="card flow-step"><span class="flow-number">2</span><h4>Classify</h4><p>Apply deterministic P0, P1, P2, or P3 incident rules.</p></article><article class="card flow-step"><span class="flow-number">3</span><h4>Investigate</h4><p>Correlate failures with endpoints, deployments, and recent changes.</p></article><article class="card flow-step"><span class="flow-number">4</span><h4>Prepare</h4><p>Create a separate incident branch, minimal fix, and test evidence.</p></article><article class="card flow-step"><span class="flow-number">5</span><h4>Review</h4><p>Open a pull request. The owner approves merge and deployment.</p></article><article class="card flow-step"><span class="flow-number">6</span><h4>Verify</h4><p>Confirm the exact approved revision is healthy after deployment.</p></article></section>
  ${sectionHead('Safety controls')}
  <section class="guardrail-grid"><article class="card guardrail"><h3>Owner approval required</h3><ul><li>Merge a prepared pull request</li><li>Deploy or promote a production revision</li><li>Change provider credentials or access</li><li>Approve a high-risk remediation</li></ul></article><article class="card guardrail prohibited"><h3>Agent never allowed</h3><ul><li>Push directly to main</li><li>Delete production data or run destructive SQL</li><li>Modify Supabase RLS, Auth, or security policy</li><li>Expose secrets in the office, logs, or artifacts</li></ul></article></section>
  <article class="office-note"><strong>Operating policy:</strong> ${esc(policy.cadence || 'Hourly monitoring')} · ${esc(policy.alert_rule || 'P0/P1 owner alerts')} · sanitized artifacts retained for ${fmt.format(policy.artifact_retention_days || 14)} days · recurring checks use no AI model and hold no production-write capability.</article>`;
};

async function updatePartnerAccess(button) {
  const enabled = button.dataset.enabled === 'true';
  const next = !enabled;
  const action = next ? 'give this café free partner access' : 'turn off this café’s free partner access';
  if (!confirm(`Are you sure you want to ${action}?`)) return;
  button.disabled = true;
  button.textContent = 'Updating…';
  try {
    const response = await fetch('/api/analytics', { method: 'PATCH', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: button.dataset.partnerId, enabled: next }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not update access');
    await load();
  } catch (error) {
    button.disabled = false;
    button.textContent = enabled ? 'Turn off free access' : 'Give free partner access';
    alert(error.message || 'Could not update partner access');
  }
}

async function load() {
  const view = document.getElementById('view');
  const refresh = document.getElementById('refresh');
  refresh.disabled = true;
  view.className = 'loading';
  view.textContent = 'Refreshing private analytics…';
  try {
    const page = document.body.dataset.page || 'overview';
    const endpoint = page === 'reliability' ? '/api/reliability' : '/api/analytics';
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load analytics');
    dataCache = data;
    view.className = '';
    view.innerHTML = (renderers[page] || renderers.overview)(data);
    document.getElementById('fresh').textContent = `Updated ${new Date(data.generated_at).toLocaleString()}`;
  } catch (error) {
    view.className = 'error';
    view.textContent = error.message || 'Could not open the owner dashboard.';
  } finally {
    refresh.disabled = false;
  }
}

async function logout() {
  const button = document.getElementById('logout');
  button.disabled = true;
  button.textContent = 'Signing out…';
  await client?.auth.signOut().catch(() => {});
  location.replace('/');
}

async function boot() {
  const page = document.body.dataset.page || 'overview';
  mountShell(page);
  try {
    const configResponse = await fetch('/api/config', { cache: 'no-store' });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok || !config.supabaseUrl || !config.supabasePublishableKey) throw new Error('Account service is temporarily unavailable.');
    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    const result = await client.auth.getSession();
    session = result.data.session;
    if (!session) return location.replace('/login?reason=required');
    await load();
  } catch (error) {
    const view = document.getElementById('view');
    view.className = 'error';
    view.textContent = error.message || 'Could not open the owner dashboard.';
  }
}

boot();
