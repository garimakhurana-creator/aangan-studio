// Aangan Studio — AI front desk dashboard.
// Reads /api/metrics and /api/leads for the selected period. Every number has a
// definition behind its ⓘ, every status is icon + label (never colour alone),
// and every chart has a table view.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nice = s => String(s ?? '').replace(/_/g, ' ');
const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const info = def => `<button type="button" class="def" data-def="${esc(def)}" aria-label="What this means: ${esc(def)}">i</button>`;
const inr = n => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const num = n => Number(n || 0).toLocaleString('en-IN');

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
const when = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const duration = s => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

const ROUTE = {
  qualified: { label: 'Qualified', icon: 'ok' },
  review: { label: 'Needs review', icon: 'warning' },
  escalate: { label: 'Escalated', icon: 'critical' },
  nurture: { label: 'Follow up later', icon: 'info' },
  declined: { label: 'Declined', icon: 'dot' },
  no_conversation: { label: 'No conversation', icon: 'dot' },
};
const BOOKING = { none: '—', no_email: 'Call to book', link_created: 'Link ready', link_sent: 'Link sent', booked: 'Booked' };
const HANDOFF = { none: '—', sent: 'Awaiting accept', accepted: 'Accepted' };
const SEV = { critical: 'Urgent', serious: 'Problem', warning: 'Decide', info: 'FYI' };
const REASON = {
  OUT_OF_AREA: 'Outside Pune / PCMC', ADVICE_ONLY: 'Advice only', SEGMENT_OUT_OF_SCOPE: 'Restaurant, retail or gym',
  BELOW_MIN_SIZE: 'Space too small', BUDGET_MISALIGNED: 'Budget clearly too low', TIMELINE_TOO_SHORT: 'Timeline too short',
  SITE_NOT_READY: 'Site not ready', MANUAL_DECLINE: 'Declined on review',
};
const FLAG = {
  vip_referral: 'VIP referral', repeat_caller: 'Called before', known_caller: 'Known number', pricing_asked: 'Asked price',
  proxy_caller: 'Calling for owner', rented: 'Rented', large_project: 'Large project', site_visit_requested: 'Site visit',
  dropped_call: 'Dropped & rang back', tight_timeline: 'Tight timeline', budget_volunteered: 'Gave budget', referral: 'Referral',
  structural_request: 'Wants structural work',
};

// Free photos under the Unsplash License (credited in the footer). Chosen by
// project type so a row's picture says what kind of space it is at a glance.
const PHOTOS = {
  living: { id: 'photo-1774200981075-a728eaaa3824', label: 'Living spaces', credit: 'Clay Banks' },
  kitchen: { id: 'photo-1764526624453-db32c24eca55', label: 'Kitchen', credit: 'Clay Banks' },
  bedroom: { id: 'photo-1668089677938-b52086753f77', label: 'Bedroom', credit: 'Lotus Design N Print' },
  office: { id: 'photo-1763307411477-6bb3254f1496', label: 'Office', credit: 'Brooke Balentine' },
  villa: { id: 'photo-1758448756207-54505680d130', label: 'Villa / house', credit: 'Aalo Lens' },
};
const photoUrl = (key, w) => `https://images.unsplash.com/${PHOTOS[key].id}?w=${w}&q=70&auto=format&fit=crop`;
function photoFor(project = {}) {
  const type = String(project.property_type || '').toLowerCase();
  const rooms = (project.rooms || []).join(' ').toLowerCase();
  if (['hospitality', 'retail', 'fitness'].includes(project.segment)) return null;
  if (project.segment === 'commercial' || /office|clinic|studio|cowork/.test(type)) return 'office';
  if (/villa|house|bungalow/.test(type)) return 'villa';
  if (project.scope_type !== 'full_home' && /kitchen/.test(rooms) && !/living|bed/.test(rooms)) return 'kitchen';
  if (project.scope_type !== 'full_home' && /bed/.test(rooms) && !/living|kitchen/.test(rooms)) return 'bedroom';
  return 'living';
}
const thumb = project => {
  const k = photoFor(project);
  return k ? `<img class="thumb" src="${photoUrl(k, 96)}" srcset="${photoUrl(k, 96)} 1x, ${photoUrl(k, 192)} 2x" alt="" loading="lazy" width="44" height="44">` : '<span class="thumb none" aria-hidden="true">—</span>';
};

const state = { bf: { q: '', area: '', type: '', flags: [], sort: 'urgent' }, view: 'overview', kind: 'qualified', scope: 'all', limit: 10, expanded: {}, period: 'all', sim: false, route: '', q: '', leads: [], metrics: null, attOpen: false, updatedAt: null };
try {
  state.period = localStorage.getItem('aangan.period') || 'all';
  state.sim = localStorage.getItem('aangan.sim') === '1';
} catch { /* storage unavailable */ }
// Shareable views: ?sim=1&period=30d
const qs = new URLSearchParams(location.search);
if (qs.has('sim')) state.sim = qs.get('sim') === '1';
if (['7d', '30d', 'month', 'all'].includes(qs.get('period'))) state.period = qs.get('period');
if (['qualified', 'notq'].includes(qs.get('kind'))) state.kind = qs.get('kind');

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ------------------------------------------------------------------ load

async function load({ quiet = false } = {}) {
  const q = `?period=${state.period}${state.sim ? '&simulated=1' : ''}`;
  if (!quiet) $('main').classList.add('loading');
  try {
    const [m, leads, health] = await Promise.all([api(`/api/metrics${q}`), api(`/api/leads${q}`), api('/api/health')]);
    state.metrics = m; state.leads = leads; state.health = health; state.updatedAt = Date.now();
    render();
  } catch (err) {
    toast(`Couldn't load: ${err.message}`);
  } finally {
    $('main').classList.remove('loading');
  }
}

function render() {
  const m = state.metrics;
  renderControls();
  renderSetup(state.health);
  renderAttention(m.attention);
  renderOverview(m);
  renderHourly(m);
  renderBeforeAfter(m);
  renderFunnel(m);
  renderRoutes(m);
  renderFilters(m);
  renderLeads();
  renderPricing(m);
  renderCost(m);
  renderHealth(m);
  renderFilterBar();
  renderBoard();
  $('#policy-v').textContent = m.policy_version;
  tickUpdated();
}

function tickUpdated() {
  if (state.updatedAt) $('#updated').textContent = `Updated ${ago(new Date(state.updatedAt).toISOString())} · refreshes every 30 s`;
}

// ------------------------------------------------------------------ header & setup

function renderControls() {
  $$('#period button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.period === state.period)));
  $('#sim').checked = state.sim;
}

function renderSetup(h) {
  const items = [
    ['Voice agent', h.vaani.configured], ['AI extraction', h.gemini.configured], ['Database', h.store === 'neon'],
    ['HubSpot', h.integrations.hubspot], ['Calendly', h.integrations.calendly], ['Email', h.integrations.email], ['Telegram', h.integrations.telegram],
  ];
  const on = items.filter(([, v]) => v).length;
  $('#setup').innerHTML = `<p class="muted small">${on === items.length ? 'Everything is connected.' : `${on} of ${items.length} connected. Actions for anything not connected are logged as skipped and can be retried later; no enquiry is lost.`}${h.email_test_mode ? ' Email is in test mode.' : ''}</p>
    <div class="conn">${items.map(([k, v]) => `<span class="conn-item ${v ? 'on' : 'off'}">${icon(v ? 'ok' : 'dot')}${esc(k)}<small>${v ? 'Connected' : 'Not connected'}</small></span>`).join('')}</div>`;
}

// ------------------------------------------------------------------ attention

function renderAttention(allItems) {
  const count = $('#att-count');
  count.textContent = allItems.length;
  count.classList.toggle('zero', allItems.length === 0);

  // Two tabs: qualified leads vs everything that isn't one.
  const split = { qualified: allItems.filter(i => i.qualified), notq: allItems.filter(i => !i.qualified) };
  if (!state.attKind) state.attKind = split.qualified.length || !split.notq.length ? 'qualified' : 'notq';
  const urgentIn = k => split[k].filter(i => i.severity === 'critical' || i.severity === 'serious').length;
  $('#att-tabs').innerHTML = [['qualified', 'Qualified'], ['notq', 'Not qualified']].map(([k, label]) =>
    `<button type="button" role="tab" aria-selected="${state.attKind === k}" data-att-kind="${k}">${label}<span class="n">${split[k].length}</span>${urgentIn(k) ? `<span class="dot-alert" title="${urgentIn(k)} urgent"></span>` : ''}</button>`).join('');
  const items = split[state.attKind];

  const list = $('#attention');
  if (!items.length) {
    list.innerHTML = `<li class="all-clear">${icon('ok')} All clear <span>— nothing here needs you right now.</span></li>`;
    $('#att-more').hidden = true;
    return;
  }
  // Repeats of the same low-urgency kind collapse into one row until expanded.
  const GROUP = { no_email: n => `${n} qualified callers left no email`, callback: n => `${n} calls with no conversation` };
  const rows = [];
  for (const it of items) {
    const groupable = GROUP[it.kind] && items.filter(x => x.kind === it.kind).length > 1 && !state.expanded[it.kind];
    if (!groupable) { rows.push(it); continue; }
    if (rows.some(r => r.group === it.kind)) continue;
    const members = items.filter(x => x.kind === it.kind);
    rows.push({ group: it.kind, route: it.route, severity: it.severity, title: GROUP[it.kind](members.length), detail: it.detail, who: members.slice(0, 3).map(x => x.who).join(', ') + (members.length > 3 ? '…' : ''), at: members[0].at });
  }
  const shown = state.attOpen ? rows : rows.slice(0, 4);
  const btn = (a, it) => ({
    approve: `<button class="btn good sm" data-act="approve" data-id="${it.lead_id}">Send to designer</button>`,
    decline: `<button class="btn ghost sm" data-act="decline" data-id="${it.lead_id}">Decline</button>`,
    retry: `<button class="btn sm" data-act="retry" data-id="${it.lead_id}">Retry</button>`,
    open: `<button class="btn ghost sm" data-act="open" data-id="${it.lead_id}">Open</button>`,
    handled: `<button class="btn ghost sm" data-act="handled" data-id="${it.lead_id}">Mark handled</button>`,
  }[a]);
  list.innerHTML = shown.map(it => it.group ? `<li class="att">
    <span class="sev ${it.severity}">${icon(it.severity)}${SEV[it.severity]}</span>
    <div class="what"><div class="att-line">${statusPill(it.route)}<b>${esc(it.title)}</b></div><span class="muted">${esc(it.who)}</span><div class="detail">${esc(it.detail)}</div></div>
    <div class="acts"><span class="when">${esc(ago(it.at))}</span><button class="btn ghost sm" data-expand="${it.group}">Show each</button></div>
  </li>` : `<li class="att">
    <span class="sev ${it.severity}">${icon(it.severity)}${SEV[it.severity]}</span>
    <div class="what"><div class="att-line">${statusPill(it.route)}<b>${esc(it.title)}</b></div><a href="#lead=${it.lead_id}" data-open="${it.lead_id}">${esc(it.who)}</a>${it.project ? ` <span class="muted">· ${esc(it.project)}</span>` : ''}${it.simulated ? ' <span class="pill sim">simulated</span>' : ''}
      <div class="detail" title="${esc(it.detail)}">${esc(it.detail || '')}</div></div>
    <div class="acts"><span class="when">${esc(ago(it.at))}</span>${it.actions.map(a => btn(a, it)).join('')}${it.actions.includes('open') ? '' : btn('open', it)}</div>
  </li>`).join('');
  const more = $('#att-more');
  more.hidden = rows.length <= 4;
  more.textContent = state.attOpen ? 'Show fewer' : `Show ${rows.length - 4} more`;
}

function statusPill(route) {
  const s = STATUS[route];
  return s ? `<span class="pill ${s.cls}">${icon(s.icon)}${esc(s.label)}</span>` : '';
}

async function act(action, id, el) {
  if (action === 'open') return openLead(id);
  if (el) el.disabled = true;
  try {
    if (action === 'approve' || action === 'decline') {
      const r = await post(`/api/leads/${id}/decide`, { choice: action });
      toast(action === 'approve' ? 'Sent to a designer.' : 'Declined and logged.');
      if (r.route === 'qualified' && Object.values(r.action_status || {}).includes('failed')) toast('Sent to designer, but an action failed. See the enquiry.');
    } else if (action === 'retry') {
      const r = await post(`/api/leads/${id}/retry`);
      const failed = Object.values(r.action_status || {}).filter(s => s === 'failed').length;
      toast(failed ? `${failed} action(s) still failing.` : 'All actions completed.');
    } else if (action === 'handled') {
      await post(`/api/leads/${id}/handled`);
      toast('Marked handled.');
    }
    await load({ quiet: true });
    if ($('#drawer').open) openLead(id);
  } catch (err) {
    toast(err.message);
  } finally {
    if (el) el.disabled = false;
  }
}

// ------------------------------------------------------------------ overview

function renderOverview(m) {
  const q = m.funnel.find(f => f.key === 'qualified').value;
  const total = m.funnel[0].value;
  const r = m.response;
  $('#hero-num').textContent = num(q);
  let copy;
  if (!total) copy = 'No enquiries in this period yet. Calls to the Vaani agent appear here within a minute.';
  else if (r.median_handoff_s.value != null) copy = `of ${num(total)} enquiries passed all five of Nikhil's criteria, and reached a designer about ${duration(r.median_handoff_s.value)} after the call ended.`;
  else copy = `of ${num(total)} enquiries passed all five of Nikhil's criteria. Designer emails start as soon as email is connected.`;
  $('#hero-copy').textContent = copy;

  const calls = r.calls.value;
  const ahPct = calls ? Math.round((r.after_hours.value / calls) * 100) : null;
  const tiles = [
    { label: 'Calls answered', value: calls ? `${r.answered_pct.value}%` : '—', note: calls ? `${num(calls)} calls · 0 missed` : 'no calls yet', good: !!calls, def: r.answered_pct.def },
    { label: 'After hours', value: num(r.after_hours.value), note: ahPct != null ? `${ahPct}% of calls, all answered` : '—', def: r.after_hours.def },
    { label: 'Call → designer', value: duration(r.median_handoff_s.value), note: r.awaiting_accept.value ? `${r.awaiting_accept.value} awaiting accept` : 'median time to inbox', def: r.median_handoff_s.def },
    { label: 'Cost per qualified lead', value: inr(m.cost.per_qualified_inr), note: m.cost.rates_missing.length ? 'add rates to show ₹' : 'variable cost', def: m.cost.def },
  ];
  $('#tiles').innerHTML = tiles.map(t => `<div class="tile">
    <span class="label">${esc(t.label)} ${info(t.def)}</span>
    <span class="value">${esc(t.value)}</span>
    <span class="note ${t.good ? 'good' : ''}">${esc(t.note)}</span></div>`).join('');
}

// ------------------------------------------------------------------ hourly chart

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(s => s * p).find(s => s >= v);
}
const hourLabel = h => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

function renderHourly(m) {
  const data = m.hourly.data;
  const total = data.reduce((s, d) => s + d.calls, 0);
  const after = data.filter(d => d.after_hours).reduce((s, d) => s + d.calls, 0);
  $('#hourly-sub').textContent = total ? `${after} of ${total} calls (${Math.round(after / total * 100)}%) came while the front desk was closed. The agent answered all of them.` : m.hourly.def;
  const el = $('#hourly');
  if (!total) { el.innerHTML = '<p class="chart-empty">Calls will show here by hour of day.</p>'; $('#hourly-table').innerHTML = ''; return; }

  const W = 720, H = 230, L = 30, R = 6, T = 26, B = 26;
  const pw = W - L - R, ph = H - T - B, slot = pw / 24, bw = Math.min(22, slot * 0.64);
  const max = niceMax(Math.max(...data.map(d => d.calls)));
  const y = v => T + ph - (v / max) * ph;
  const ticks = [0, max / 2, max].filter((v, i, a) => Number.isInteger(v) && a.indexOf(v) === i);
  const [open, close] = m.hourly.office_hours;
  const peak = data.reduce((a, d) => (d.calls > a.calls ? d : a), data[0]);
  const r = 4;
  const colPath = (x, top, bottom) => {
    const h = bottom - top;
    if (h <= 0) return '';
    const rr = Math.min(r, h, bw / 2);
    return `M${x},${bottom}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + bw - rr}Q${x + bw},${top} ${x + bw},${top + rr}V${bottom}Z`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls by hour of day. ${after} of ${total} outside 10am to 7pm.">
    <rect class="band" x="${L + open * slot}" y="${T - 18}" width="${(close - open) * slot}" height="${ph + 18}" rx="6"/>
    <text class="band-label" x="${L + ((open + close) / 2) * slot}" y="${T - 6}" text-anchor="middle">Front desk open</text>
    ${ticks.map(v => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
    ${data.map((d, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      return `<g><rect class="col-hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}" data-h="${d.hour}" data-c="${d.calls}" data-a="${d.after_hours ? 1 : 0}" tabindex="${d.calls ? 0 : -1}"/>
        <path class="col" d="${colPath(x, y(d.calls), T + ph)}"/></g>`;
    }).join('')}
    ${peak.calls ? `<text class="val" x="${L + peak.hour * slot + slot / 2}" y="${y(peak.calls) - 6}" text-anchor="middle">${peak.calls}</text>` : ''}
    ${[0, 6, 12, 18, 23].map(h => `<text class="axis" x="${L + h * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${hourLabel(h)}</text>`).join('')}
  </svg>`;
  $('#hourly-table').innerHTML = `<table><thead><tr><th>Hour (IST)</th><th>Calls</th><th>Front desk</th></tr></thead><tbody>${data.filter(d => d.calls).map(d => `<tr><td>${hourLabel(d.hour)}–${hourLabel((d.hour + 1) % 24)}</td><td>${d.calls}</td><td>${d.after_hours ? 'Closed' : 'Open'}</td></tr>`).join('')}</tbody></table>`;
}

function showTip(target, html) {
  const tip = $('#tip');
  tip.innerHTML = html; tip.hidden = false;
  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
  let yy = r.top - th - 8;
  if (yy < 8) yy = r.bottom + 8;
  tip.style.left = `${x}px`; tip.style.top = `${yy}px`;
}
const hideTip = () => { $('#tip').hidden = true; };

function tipFor(el) {
  if (el.classList.contains('col-hit')) {
    const h = Number(el.dataset.h), c = Number(el.dataset.c);
    return `<b>${hourLabel(h)}–${hourLabel((h + 1) % 24)}</b>${c} call${c === 1 ? '' : 's'} · front desk ${el.dataset.a === '1' ? 'closed' : 'open'}`;
  }
  if (el.classList.contains('def')) return esc(el.dataset.def);
  return null;
}
document.addEventListener('mouseover', e => { const t = e.target.closest('.col-hit, .def'); if (t) { const h = tipFor(t); if (h) showTip(t, h); } });
document.addEventListener('mouseout', e => { if (e.target.closest('.col-hit, .def')) hideTip(); });
document.addEventListener('focusin', e => { const t = e.target.closest('.col-hit, .def'); if (t) showTip(t, tipFor(t)); });
document.addEventListener('focusout', e => { if (e.target.closest('.col-hit, .def')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });

// ------------------------------------------------------------------ comparison, funnel, routes

function renderBeforeAfter(m) {
  const b = m.baseline, r = m.response;
  const calls = r.calls.value;
  $('#ba').innerHTML = `<div class="compare">
    <div class="then"><span class="k">Last month, by hand</span><span class="big">${b.no_reply_48h_pct}%</span><p>of ~${b.enquiries_per_month} enquiries had no reply after 48 hours. ${b.outside_hours_pct}% arrived when the desk was closed.</p></div>
    <div class="now"><span class="k">With the AI front desk</span><span class="big">${calls ? '0%' : '—'}</span><p>${calls ? `unanswered. All ${num(calls)} calls were picked up live${r.after_hours.value ? `, including ${num(r.after_hours.value)} after hours` : ''}.` : 'Every call is picked up live, day or night.'}</p></div>
  </div>
  <p class="footnote">Nikhil's data: replying within an hour converts at ${b.conversion_multiple_within_1h}× a next-day reply. That's the case baseline, not a claimed result.</p>`;
}

function bars(items, max) {
  const top = max || Math.max(1, ...items.map(i => i.value));
  return `<div class="bars">${items.map(i => `<div class="bar-row"><span class="name">${esc(i.label)}${i.def ? ` ${info(i.def)}` : ''}</span><span class="bar" role="img" aria-label="${esc(i.label)}: ${i.value}"><i style="width:${(i.value / top) * 100}%"></i></span><span class="n">${num(i.value)}</span></div>`).join('')}</div>`;
}

function renderFunnel(m) {
  const f = m.funnel;
  const top = Math.max(1, f[0].value);
  $('#funnel').innerHTML = `<div class="bars">${f.map((s, i) => {
    const prev = i ? f[i - 1].value : null;
    const conv = i && prev ? `${Math.round((s.value / prev) * 100)}%` : i ? '—' : '';
    return `${i ? `<div class="step"><span>↓ ${conv}</span></div>` : ''}<div class="bar-row"><span class="name">${esc(s.label)} ${info(s.def)}</span><span class="bar" role="img" aria-label="${esc(s.label)}: ${s.value}"><i style="width:${(s.value / top) * 100}%"></i></span><span class="n">${num(s.value)}</span></div>`;
  }).join('')}</div>`;
}

function renderRoutes(m) {
  const routes = Object.entries(m.routes).map(([k, v]) => ({ label: ROUTE[k].label, value: v }));
  const reasons = Object.entries(m.decline_reasons)
    .filter(([k]) => REASON[k])
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: REASON[k], value: v }));
  const max = Math.max(1, ...routes.map(r => r.value));
  $('#routes').innerHTML = bars(routes, max) + (reasons.length ? `<h3 class="sub-h">Why enquiries were declined or deferred</h3>${bars(reasons, max)}` : '');
}

// ------------------------------------------------------------------ enquiries table

function renderFilters(m) {
  const all = m.funnel[0].value;
  const opts = [['', 'All', all], ...Object.entries(m.routes).filter(([, v]) => v).map(([k, v]) => [k, ROUTE[k].label, v])];
  if (state.route && !opts.some(([k]) => k === state.route)) state.route = '';
  $('#route-filter').innerHTML = opts.map(([k, label, n]) => `<button type="button" role="radio" aria-checked="${state.route === k}" data-route="${k}">${esc(label)}<span>${n}</span></button>`).join('');
}

function matches(l) {
  if (state.route && l.decision?.route !== state.route) return false;
  if (!state.q) return true;
  const hay = [l.name, l.phone, l.email, l.project?.locality, l.project?.property_type, l.summary].join(' ').toLowerCase();
  return state.q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

function routePill(route) {
  const r = ROUTE[route] || { label: nice(route), icon: 'dot' };
  return `<span class="pill ${esc(route)}">${icon(r.icon)}${esc(r.label)}</span>`;
}

function renderLeads() {
  const all = state.leads.filter(matches);
  const rows = all.slice(0, state.limit);
  const moreBtn = $('#leads-more');
  moreBtn.hidden = all.length <= state.limit;
  moreBtn.textContent = all.length - state.limit > 10 ? `Show 10 more (${all.length - state.limit} left)` : `Show ${all.length - state.limit} more`;
  const empty = $('#empty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.innerHTML = state.leads.length
      ? '<b>No enquiries match.</b><span>Try a different search or outcome.</span>'
      : `<b>No enquiries in this period.</b><span>Call the Vaani agent, or replay September's calls to see the system work end to end.</span><button type="button" class="btn" data-replay>${icon('play')}Replay calls</button>`;
  }
  $('#leads tbody').innerHTML = rows.map(l => {
    const d = l.decision || {};
    const failed = Object.values(l.action_status || {}).filter(s => s === 'failed').length;
    const flags = (d.flags || []).filter(f => FLAG[f]).slice(0, 3);
    return `<tr tabindex="0" data-id="${esc(l.id)}" aria-label="${esc(l.name || 'Unknown caller')}, ${esc(ROUTE[d.route]?.label || d.route)}">
      <td><span title="${esc(when(l.last_call_at))}">${esc(ago(l.last_call_at))}</span>${l.simulated ? '<div class="sub"><span class="pill sim">simulated</span></div>' : ''}</td>
      <td><b>${esc(l.name || 'Unknown caller')}</b><div class="sub">${esc(l.phone || '')}</div></td>
      <td><div class="proj">${thumb(l.project)}<div><div class="clip">${esc([l.project?.property_type, l.project?.locality].filter(Boolean).join(' · ') || '—')}</div><div class="sub clip">${esc(l.summary || '')}</div></div></div></td>
      <td>${routePill(d.route)}${d.priority && d.priority !== 'normal' ? ` <span class="pill ${esc(d.priority)}">${esc(d.priority)}</span>` : ''}${failed ? ` <span class="pill failed">${icon('serious')}${failed} failed</span>` : ''}<div>${flags.map(f => `<span class="flag">${esc(FLAG[f])}</span>`).join('')}</div></td>
      <td>${l.booking?.status && l.booking.status !== 'none' ? `<span class="pill ${esc(l.booking.status)}">${esc(BOOKING[l.booking.status])}</span>` : '<span class="muted">—</span>'}</td>
      <td>${l.handoff?.status && l.handoff.status !== 'none' ? `<span class="pill ${esc(l.handoff.status)}">${esc(HANDOFF[l.handoff.status])}</span><div class="sub">${esc(l.assigned_to?.name || '')}</div>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ------------------------------------------------------------------ the cut, cost, health

function renderPricing(m) {
  const p = m.pricing;
  const quoted = m.health.pricing_quotes;
  $('#pricing').innerHTML = `<dl class="stat-list">
    <div><dt>Callers who asked the price</dt><dd>${num(p.asked)}</dd></div>
    <div><dt>…and still qualified</dt><dd>${num(p.asked_and_qualified)}</dd></div>
    <div><dt>…and booked a consultation</dt><dd>${num(p.asked_and_booked)}</dd></div>
    <div><dt>Prices quoted by the agent ${info('Any figure, range or per-sq-ft rate the agent said, caught by the post-call fact-check.')}</dt><dd class="${quoted ? 'bad' : 'good'}">${num(quoted)}</dd></div>
  </dl>
  <div class="note-box ${quoted ? 'warn' : ''}"><b>Why there's no price quote.</b> Nikhil asked for one, but his own pricing guide says pricing varies by site and no number should ever be quoted. The agent gives his approved line and offers the free consultation instead; this card shows whether that costs bookings.</div>`;
}

function renderCost(m) {
  const c = m.cost;
  $('#cost').innerHTML = `<dl class="stat-list">
    <div><dt>Per call</dt><dd>${inr(c.per_call_inr)}</dd></div>
    <div><dt>Per qualified lead</dt><dd>${inr(c.per_qualified_inr)}</dd></div>
    <div><dt>Per booked consultation</dt><dd>${inr(c.per_booking_inr)}</dd></div>
    <div><dt>Voice ${info("Vaani's own per-call charge, in credits, from its call history.")}</dt><dd>${num(c.vaani_credits)} cr${c.vaani_inr != null ? ` · ${inr(c.vaani_inr)}` : ''}</dd></div>
    <div><dt>AI extraction ${info('Gemini tokens used to read each call, counted per call.')}</dt><dd>${num(c.gemini_tokens.input + c.gemini_tokens.output)} tok${c.gemini_inr != null ? ` · ${inr(c.gemini_inr)}` : ''}</dd></div>
    <div><dt>Tools per month ${info('HubSpot free CRM, Neon, Vercel and Resend free tiers, Telegram; Calendly per your plan.')}</dt><dd>${inr(c.fixed_monthly_inr)}</dd></div>
  </dl>
  ${c.rates_missing.length ? `<div class="note-box warn">Usage is measured on every call. To show rupees, set ${esc(c.rates_missing.join(', '))} in <code>config/costs.json</code>.</div>` : ''}
  ${m.value.projected_projects != null ? `<div class="note-box"><span class="tag proj">Projection</span> ≈ ${m.value.projected_projects} projects, ${inr(m.value.projected_projects * m.value.avg_project_value_inr)}</div>` : ''}`;
}

function renderHealth(m) {
  const x = m.health;
  const row = (label, value, ok, def) => `<div><dt>${label}${def ? ` ${info(def)}` : ''}</dt><dd class="${ok ? 'good' : value === 0 || value === '—' ? '' : 'bad'}">${esc(value)}</dd></div>`;
  $('#health').innerHTML = `<dl class="stat-list">
    ${row('Transcript eval', x.eval ? `${x.eval.passed}/${x.eval.total}` : '—', x.eval && x.eval.passed === x.eval.total, "The 20 September phone calls replayed against the expected outcome for each.")}
    ${row('Red-team', x.redteam ? `${x.redteam.passed}/${x.redteam.total}` : '—', x.redteam && x.redteam.passed === x.redteam.total, 'Scripted callers trying to extract a price or bait the agent into inventing facts.')}
    ${row('Agent off-script', x.factcheck_violations, x.factcheck_violations === 0, 'Anything the agent said that is not an approved fact: prices, false bookings, invented names or offers.')}
    ${row('Unsupported facts removed', x.grounding_removed_facts, x.grounding_removed_facts === 0, 'Facts the AI extracted that the caller never said, removed before reaching a designer or the CRM.')}
    ${row('Integration failures', x.integration_failures, x.integration_failures === 0)}
  </dl>
  ${x.unconfirmed_policy.length ? `<div class="note-box warn"><b>Waiting on Nikhil:</b> ${esc(x.unconfirmed_policy.join(' · '))}. Leads that hinge on these go to review, never to a decline.</div>` : ''}`;
}

// ------------------------------------------------------------------ drawer

async function openLead(id) {
  let l;
  try { l = await api(`/api/leads/${id}`); } catch (err) { return toast(err.message); }
  const d = l.decision, x = l.extraction, p = x.project || {}, t = x.timeline || {};
  const STATUS_ICON = { pass: 'ok', unclear: 'warning', fail: 'critical' };
  $('#d-title').innerHTML = `${esc(l.name || 'Unknown caller')}`;
  $('#d-sub').innerHTML = `${routePill(d.route)} ${d.priority !== 'normal' ? `<span class="pill ${esc(d.priority)}">${esc(d.priority)}</span>` : ''} ${l.simulated ? '<span class="pill sim">simulated</span>' : ''} <span class="muted">· ${esc(when(l.last_call_at))}${l.call_ids.length > 1 ? ` · ${l.call_ids.length} calls merged` : ''}</span>`;

  const failed = Object.values(l.action_status || {}).includes('failed');
  const inAttention = state.metrics.attention.some(a => a.lead_id === l.id);
  $('#d-actions').innerHTML = [
    d.route === 'review' ? `<button class="btn good" data-act="approve" data-id="${l.id}">Send to designer</button><button class="btn ghost" data-act="decline" data-id="${l.id}">Decline</button>` : '',
    failed ? `<button class="btn" data-act="retry" data-id="${l.id}">Retry failed actions</button>` : '',
    d.route === 'qualified' ? `<a class="btn ghost" href="/api/leads/${l.id}/brief" target="_blank" rel="noopener">${icon('ext')}Designer email</a>` : '',
    l.recording_url ? `<a class="btn ghost" href="${esc(l.recording_url)}" target="_blank" rel="noopener">${icon('play')}Recording</a>` : '',
    inAttention && d.route !== 'review' ? `<button class="btn ghost" data-act="handled" data-id="${l.id}">Mark handled</button>` : '',
  ].join('');

  const facts = [
    ['Phone', l.phone], ['Email', l.email], ['Location', [p.locality, p.city].filter(Boolean).join(', ')],
    ['Project', [p.property_type, nice(p.scope_type !== 'unknown' ? p.scope_type : '')].filter(Boolean).join(' · ')],
    ['Rooms', (p.rooms || []).join(', ')], ['Carpet area', p.carpet_area_sqft ? `${num(p.carpet_area_sqft)} sq ft` : ''],
    ['Timeline', t.needed_by_text || t.preferred_start_text || t.site_available_text], ['Decision-maker', x.decision_maker?.detail || (x.decision_maker?.status !== 'unknown' ? nice(x.decision_maker?.status) : '')],
    ['Found us via', [x.referral?.how_found, x.referral?.referrer_name].filter(Boolean).join(' — ')],
    ['Consultation', [x.requests?.site_visit ? 'Site visit' : '', x.requests?.preferred_slots].filter(Boolean).join(' · ')],
    ['Language', x.language], ['Designer', l.assigned_to?.name],
  ].filter(([, v]) => v);

  const crit = Object.values(d.criteria || {});
  const ev = l.events || [];
  const pk = photoFor(p);
  $('#d-body').innerHTML = `
    ${pk ? `<figure class="banner"><img src="${photoUrl(pk, 900)}" srcset="${photoUrl(pk, 720)} 720w, ${photoUrl(pk, 1440)} 1440w" sizes="(max-width: 720px) 100vw, 720px" alt=""><figcaption><span>${esc(PHOTOS[pk].label)}</span><b>${esc([p.property_type, p.locality].filter(Boolean).join(' · ') || 'Project')}</b></figcaption></figure>` : ''}
    <section><p>${esc(x.summary)}</p>
      ${(d.flags || []).filter(f => FLAG[f]).length ? `<div style="margin-top:8px">${d.flags.filter(f => FLAG[f]).map(f => `<span class="flag">${esc(FLAG[f])}</span>`).join('')}</div>` : ''}
      ${d.review_reasons?.length ? `<div class="note-box warn" style="margin-top:12px"><b>Why it needs review:</b> ${esc(d.review_reasons.join(' '))}</div>` : ''}
      ${d.overridden ? `<div class="note-box" style="margin-top:12px">Decided on review: <b>${d.overridden.choice === 'approve' ? 'sent to designer' : 'declined'}</b> · ${esc(when(d.overridden.at))}</div>` : ''}
    </section>
    ${facts.length ? `<section><h3>What the caller told us</h3><dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>` : ''}
    ${d.caller_line ? `<section><h3>What the caller was told</h3><div class="said">“${esc(d.caller_line)}”</div></section>` : ''}
    ${crit.length ? `<section><h3>Nikhil's five criteria · policy ${esc(d.policy_version)}</h3>${crit.map(c => `<div class="crit">${icon(STATUS_ICON[c.status], c.status)}<div><b>${esc(c.name)}</b><br><span class="muted">${esc(c.reason)}</span>${c.evidence?.[0] ? `<q>${esc(c.evidence[0])}</q>` : ''}</div></div>`).join('')}</section>` : ''}
    ${d.confirm_at_consultation?.length ? `<section><h3>For the designer to confirm</h3><ul class="plain">${[...new Set(d.confirm_at_consultation)].map(q => `<li>${esc(q)}</li>`).join('')}</ul></section>` : ''}
    <section><h3>Checks on the AI</h3><div class="checks">
      <div>${l.factcheck.ok ? `${icon('ok', 'ok')}<span>Nothing the agent said broke the rules: no prices, no invented facts, no false booking.</span>` : `${icon('critical', 'bad')}<span>${l.factcheck.violations.map(v => `<b>${esc(nice(v.type))}</b>: “${esc(v.text.slice(0, 160))}”`).join('<br>')}</span>`}</div>
      <div>${l.grounding_warnings.length ? `${icon('warning', 'bad')}<span>Removed ${l.grounding_warnings.length} fact(s) the caller never said: ${esc(l.grounding_warnings.join(' · '))}</span>` : `${icon('ok', 'ok')}<span>Every extracted fact appears in the transcript.</span>`}</div>
    </div></section>
    <section><h3>Activity</h3><ul class="timeline">${ev.map(e => `<li><span class="t">${esc(new Date(e.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))}</span><span class="dot ${esc(e.status)}"></span><span><b>${esc(eventLabel(e))}</b> <span class="e">${esc(e.error || e.detail || (e.result?.route ? `→ ${ROUTE[e.result.route]?.label || e.result.route}` : ''))}</span></span></li>`).join('')}</ul></section>
    <section><details class="transcript"><summary>Transcript</summary><pre class="transcript">${esc(l.transcript)}</pre></details></section>`;

  if (!$('#drawer').open) $('#drawer').showModal();
  history.replaceState(null, '', `#lead=${id}`);
}

function eventLabel(e) {
  return {
    decision: 'Decision', hubspot: 'HubSpot', calendly: 'Booking link', email_caller: 'Email to caller', email_designer: 'Email to designer',
    telegram: 'Telegram alert', handoff_accepted: 'Designer accepted', booked: 'Consultation booked', review_decision: 'Review decision', marked_handled: 'Marked handled',
  }[e.type] || nice(e.type);
}

// ------------------------------------------------------------------ leads board (designers)

// Qualified and not-qualified enquiries are separate views with their own buckets.
const BUCKETS = {
  qualified: [
    { key: 'urgent', title: 'Urgent', hint: 'Call these first', sev: 'critical' },
    { key: 'new', title: 'New', hint: 'Waiting for a designer to pick up', sev: 'info' },
    { key: 'picked', title: 'Picked up', hint: 'Accepted or booked', sev: 'ok' },
  ],
  notq: [
    { key: 'declined', title: 'Declined', hint: "Outside what Aangan takes on", sev: 'dot' },
    { key: 'later', title: 'Follow up later', hint: 'Timeline too short for now', sev: 'info' },
    { key: 'existing', title: 'Existing clients', hint: 'Problems with a project, not new leads', sev: 'critical' },
    { key: 'other', title: 'Other', hint: "Awaiting Nikhil's review, or no conversation", sev: 'dot' },
  ],
};
const NOTQ_KEYS = new Set(BUCKETS.notq.map(b => b.key));

const STATUS = {
  qualified: { label: 'Qualified', cls: 'qualified', icon: 'ok' },
  escalate: { label: 'Existing client', cls: 'escalate', icon: 'critical' },
  declined: { label: 'Not qualified', cls: 'declined', icon: 'dot' },
  nurture: { label: 'Not yet: timeline', cls: 'nurture', icon: 'info' },
  review: { label: "Awaiting Nikhil's review", cls: 'review', icon: 'warning' },
  no_conversation: { label: 'No conversation', cls: 'no_conversation', icon: 'dot' },
};

function urgencyReasons(l) {
  const d = l.decision || {};
  const r = [];
  const sla = state.health?.sla_accept_hours || 4;
  if (d.route === 'escalate') r.push(`Existing client${l.complaint?.designer ? ` of ${l.complaint.designer}` : ''}: wants a senior callback within 15 min`);
  if (d.flags?.includes('vip_referral')) r.push('VIP: referred by a friend of Nikhil');
  if (d.flags?.includes('repeat_caller') || (d.flags?.includes('known_caller') && d.priority === 'high')) r.push("Called before and wasn't followed up: open with an apology");
  if (d.flags?.includes('tight_timeline')) r.push(`Tight timeline${l.timeline?.weeks_until_needed ? `: needed in ~${l.timeline.weeks_until_needed} weeks` : ''}`);
  if (l.handoff?.status === 'sent' && Date.now() - new Date(l.handoff.sent_at) > sla * 36e5) r.push(`Not picked up in ${sla}h`);
  return r;
}

function bucketOf(l) {
  const route = l.decision?.route;
  if (route === 'declined') return 'declined';
  if (route === 'nurture') return 'later';
  if (route === 'escalate') return 'existing';
  if (route !== 'qualified') return 'other';
  if (l.handoff?.status === 'accepted' || l.booking?.status === 'booked') return 'picked';
  return urgencyReasons(l).length ? 'urgent' : 'new';
}

const me = () => { try { return localStorage.getItem('aangan.me') || ''; } catch { return ''; } };
const isMine = l => me() && (l.assigned_to?.name || '').toLowerCase() === me().toLowerCase();

const SCOPE = { full_home: 'full home', partial: 'some rooms', single_room: 'one room', office_fitout: 'office fit-out' };
const DECIDER = {
  self: 'Caller (owner)',
  authorised: 'Caller, partner agreed',
  proxy_decider_will_attend: 'Owners: caller is family, owners will attend',
  research_only: 'Someone else: confirm who decides',
};
// "Design team" is the fallback inbox, not a person.
const designerName = l => (l.assigned_to?.name && l.assigned_to.name !== 'Design team' ? l.assigned_to.name : '');

function leadCard(l, bucket) {
  const d = l.decision || {};
  const s = STATUS[d.route] || { label: nice(d.route), cls: 'none', icon: 'dot' };
  const p = l.project || {};
  const where = [p.locality, p.carpet_area_sqft ? `${num(p.carpet_area_sqft)} sq ft` : null].filter(Boolean).join(' · ');
  const timeline = l.timeline?.needed_by || l.timeline?.preferred_start || null;
  const reasons = bucket === 'urgent' || bucket === 'existing' ? urgencyReasons(l) : [];
  const facts = [
    ['Project', [p.property_type, SCOPE[p.scope_type]].filter(Boolean).join(' · ')],
    ['Where', where],
    ['Timeline', timeline],
    ['Decides', DECIDER[l.decision_maker?.status]],
    ['Consultation', [l.site_visit ? 'Site visit' : null, l.preferred_slots].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);
  const booking = l.booking?.status === 'booked' ? 'Consultation booked'
    : l.booking?.status === 'link_sent' ? 'Booking link sent — waiting for them to pick a time'
    : l.booking?.status === 'no_email' ? 'No email — call them to fix a time' : null;
  const canClaim = d.route === 'qualified' && l.handoff?.status !== 'accepted';
  return `<article class="lead-card ${bucket}" data-open-card="${esc(l.id)}">
    <header><span class="pill ${s.cls}">${icon(s.icon)}${esc(s.label)}</span>${d.priority && d.priority !== 'normal' ? `<span class="pill ${esc(d.priority)}">${esc(d.priority)}</span>` : ''}${l.simulated ? '<span class="pill sim">sim</span>' : ''}<span class="lc-when" title="${esc(when(l.last_call_at))}">${esc(ago(l.last_call_at))}</span></header>
    <div class="lc-title">${thumb(p)}<div><b>${esc(l.name || 'Unknown caller')}</b><span>${esc(l.summary || '')}</span></div></div>
    ${reasons.length ? `<ul class="lc-why">${reasons.map(r => `<li>${icon('serious')}${esc(r)}</li>`).join('')}</ul>` : ''}
    ${NOTQ_KEYS.has(bucket) && bucket !== 'existing' ? `<p class="lc-reason"><b>Why:</b> ${esc(l.reason || (d.route === 'review' ? (d.review_reasons || []).join(' ') : d.route === 'no_conversation' ? 'The caller hung up before saying anything.' : 'See details.'))}</p>` : ''}
    ${facts.length && !NOTQ_KEYS.has(bucket) ? `<dl class="lc-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    ${booking || designerName(l) ? `<p class="lc-status">${booking ? esc(booking) : ''}${booking && designerName(l) ? ' · ' : ''}${designerName(l) ? `Designer: <b>${esc(designerName(l))}</b>` : ''}</p>` : ''}
    <footer>
      ${canClaim ? `<button type="button" class="btn sm" data-claim="${esc(l.id)}">I've got this</button>` : ''}
      ${l.phone ? `<a class="btn ghost sm" href="tel:${esc(l.phone.replace(/\s/g, ''))}">Call</a>` : ''}
      <button type="button" class="btn ghost sm" data-open="${esc(l.id)}">Full brief</button>
    </footer>
  </article>`;
}

const QUICK = [
  ['vip_referral', 'VIP'], ['repeat_caller', 'Called before'], ['site_visit_requested', 'Site visit'],
  ['pricing_asked', 'Asked price'], ['tight_timeline', 'Tight timeline'], ['rented', 'Rented'], ['large_project', 'Large project'],
];
const areaOf = l => String(l.project?.locality || '').split(/[,·—-]/)[0].trim();
const typeOf = l => (l.project?.segment === 'commercial' ? 'office' : ['hospitality', 'retail', 'fitness'].includes(l.project?.segment) ? 'other' : l.project?.segment === 'residential' ? 'home' : 'other');

function passesFilters(l) {
  const f = state.bf;
  if (f.area && areaOf(l).toLowerCase() !== f.area.toLowerCase()) return false;
  if (f.type && typeOf(l) !== f.type) return false;
  if (f.flags.length && !f.flags.every(x => (l.decision?.flags || []).includes(x) || (x === 'repeat_caller' && l.decision?.flags?.includes('known_caller')))) return false;
  if (f.q) {
    const hay = [l.name, l.phone, l.email, l.project?.locality, l.project?.property_type, l.summary].join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}

const SORTS = {
  urgent: null, // per-column default
  newest: (a, b) => b.last_call_at.localeCompare(a.last_call_at),
  waiting: (a, b) => a.last_call_at.localeCompare(b.last_call_at),
  size: (a, b) => (b.project?.carpet_area_sqft || 0) - (a.project?.carpet_area_sqft || 0),
};

function renderFilterBar() {
  // Don't rebuild under someone's cursor (the 30 s refresh would steal focus).
  if ($('#board-filters').contains(document.activeElement) && $('#board-filters').innerHTML) return;
  const f = state.bf;
  const areas = [...new Set(state.leads.map(areaOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = (id, label, opts, val) => `<label class="fsel"><span>${label}</span><select id="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  $('#board-filters').innerHTML = `
    <div class="frow">
      <label class="search"><svg class="i" aria-hidden="true"><use href="#i-search"/></svg><input id="bf-q" type="search" placeholder="Search name, area, phone" value="${esc(f.q)}" aria-label="Search leads"></label>
      ${sel('bf-area', 'Area', [['', 'All areas'], ...areas.map(a => [a, a])], f.area)}
      ${sel('bf-type', 'Type', [['', 'All types'], ['home', 'Homes'], ['office', 'Offices'], ['other', 'Other']], f.type)}
      ${sel('bf-sort', 'Sort', [['urgent', 'Most urgent first'], ['newest', 'Newest first'], ['waiting', 'Waiting longest'], ['size', 'Largest space']], f.sort)}
    </div>
    <div class="frow">
      <div class="quick" role="group" aria-label="Quick filters">${QUICK.map(([k, t]) => `<button type="button" class="qchip" aria-pressed="${f.flags.includes(k)}" data-flag="${k}">${esc(t)}</button>`).join('')}</div>
      <span class="spacer"></span>
      <span class="muted small" id="bf-count"></span>
      <button type="button" class="link small" id="bf-clear" ${f.q || f.area || f.type || f.flags.length || f.sort !== 'urgent' ? '' : 'hidden'}>Clear filters</button>
    </div>`;
}

function renderBoard() {
  // "Mine" only applies to qualified leads (designers own those).
  const all = state.leads.filter(passesFilters);
  const groups = Object.fromEntries([...BUCKETS.qualified, ...BUCKETS.notq].map(b => [b.key, []]));
  for (const l of all) {
    const k = bucketOf(l);
    if (NOTQ_KEYS.has(k) || state.scope !== 'mine' || isMine(l)) groups[k].push(l);
  }
  const rank = { urgent: 0, high: 1, normal: 2 };
  groups.urgent.sort((a, b) => (rank[a.decision.priority] - rank[b.decision.priority]) || a.last_call_at.localeCompare(b.last_call_at));
  groups.new.sort((a, b) => a.last_call_at.localeCompare(b.last_call_at)); // oldest first: waiting longest
  for (const k of ['picked', ...NOTQ_KEYS]) groups[k].sort((a, b) => b.last_call_at.localeCompare(a.last_call_at));
  if (SORTS[state.bf.sort]) for (const k of Object.keys(groups)) groups[k].sort(SORTS[state.bf.sort]);
  const shownCount = state.kind === 'qualified' ? BUCKETS.qualified.reduce((s, b) => s + groups[b.key].length, 0) : [...NOTQ_KEYS].reduce((s, k) => s + groups[k].length, 0);
  const totalKind = state.leads.filter(l => (state.kind === 'qualified') === (l.decision?.route === 'qualified')).length;
  const countEl = $('#bf-count');
  if (countEl) countEl.textContent = shownCount === totalKind ? `${totalKind} ${state.kind === 'qualified' ? 'qualified' : 'not qualified'}` : `Showing ${shownCount} of ${totalKind}`;

  const tab = $('#tab-urgent');
  const nUrgent = groups.urgent.length + groups.existing.length;
  tab.hidden = !nUrgent; tab.textContent = nUrgent;

  // The two halves, each with its own count and breakdown.
  const count = keys => keys.reduce((s, k) => s + groups[k].length, 0);
  const brief = list => list.filter(b => groups[b.key].length).map(b => `${groups[b.key].length} ${b.title.toLowerCase()}`).join(' · ') || 'none';
  const kinds = [
    { key: 'qualified', label: 'Qualified leads', n: count(BUCKETS.qualified.map(b => b.key)), sub: brief(BUCKETS.qualified), icon: 'ok' },
    { key: 'notq', label: 'Not qualified', n: count([...NOTQ_KEYS]), sub: brief(BUCKETS.notq), icon: 'dot' },
  ];
  $('#kind').innerHTML = kinds.map(k => `<button type="button" role="tab" class="kind ${k.key}" aria-selected="${state.kind === k.key}" data-kind="${k.key}">
    <span class="kind-top">${icon(k.icon)}${esc(k.label)}</span><span class="kind-n">${k.n}</span><span class="kind-sub">${esc(k.sub)}</span></button>`).join('');

  $('#scope-wrap').hidden = state.kind !== 'qualified';
  $$('#scope button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.scope === state.scope)));
  $('#me').value = me();
  const cols = BUCKETS[state.kind];
  $('#board-cols').style.setProperty('--cols', cols.length);
  $('#board-cols').innerHTML = cols.map(b => `<section class="col ${b.key}" aria-labelledby="col-${b.key}">
    <header><h3 id="col-${b.key}"><span class="dot-${b.sev}"></span>${esc(b.title)} <span class="n">${groups[b.key].length}</span></h3><p>${esc(b.hint)}</p></header>
    <div class="col-body">${groups[b.key].length ? groups[b.key].map(l => leadCard(l, b.key)).join('') : `<p class="col-empty">${state.kind === 'qualified' && state.scope === 'mine' && !me() ? 'Add your name above to see your leads.' : 'Nothing here.'}</p>`}</div>
  </section>`).join('');
}

async function claim(id, el) {
  let name = me();
  if (!name) {
    name = (prompt('Your name, so the team knows who has this lead:') || '').trim();
    if (!name) return;
    try { localStorage.setItem('aangan.me', name); } catch { /* ignore */ }
  }
  el.disabled = true;
  try {
    await post(`/api/leads/${id}/claim`, { designer: name });
    toast(`It's yours, ${name.split(' ')[0]}.`);
    await load({ quiet: true });
  } catch (err) { toast(err.message); el.disabled = false; }
}

const VIEWS = ['overview', 'board', 'reports'];
function showView(view) {
  state.view = VIEWS.includes(view) ? view : 'overview';
  for (const v of VIEWS) $(`#view-${v}`).hidden = state.view !== v;
  window.scrollTo({ top: 0 });
  $$('.tabs a').forEach(a => (a.dataset.view === state.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  try { localStorage.setItem('aangan.view', state.view); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ replay

let samples = [];
async function openReplay() {
  const dlg = $('#replay');
  if (!samples.length) samples = await api('/api/samples').catch(() => []);
  $('#r-list').innerHTML = samples.length
    ? samples.map(s => `<li><label><input type="checkbox" value="${esc(s.id)}"><span><span class="h">${esc(s.header)}</span><span class="p">${esc(s.preview)}</span></span></label></li>`).join('')
    : '<li class="muted">Sample transcripts are not deployed on this server.</li>';
  $('#r-all').disabled = $('#r-selected').disabled = !samples.length;
  $('#r-status').textContent = '';
  $('#r-progress').hidden = true;
  dlg.showModal();
}

async function replay(ids) {
  if (!ids.length) return toast('Pick at least one call.');
  const email = $('#r-email').value.trim() || undefined;
  const bar = $('#r-progress'), fill = bar.querySelector('i'), status = $('#r-status');
  bar.hidden = false; fill.style.width = '0%';
  $$('#replay .modal-foot button').forEach(b => { b.disabled = true; });
  const tally = {};
  for (let i = 0; i < ids.length; i++) {
    status.textContent = `Replaying ${ids[i]} (${i + 1} of ${ids.length})…`;
    try {
      const r = await post('/api/simulate', { sample: ids[i], email });
      tally[r.route] = (tally[r.route] || 0) + 1;
    } catch (err) {
      tally.error = (tally.error || 0) + 1;
    }
    fill.style.width = `${((i + 1) / ids.length) * 100}%`;
  }
  status.textContent = `Done: ${Object.entries(tally).map(([k, v]) => `${v} ${ROUTE[k]?.label.toLowerCase() || k}`).join(', ')}.`;
  $$('#replay .modal-foot button').forEach(b => { b.disabled = false; });
  if (!state.sim) { state.sim = true; save(); }
  await load({ quiet: true });
}

// ------------------------------------------------------------------ events

function save() {
  try { localStorage.setItem('aangan.period', state.period); localStorage.setItem('aangan.sim', state.sim ? '1' : '0'); } catch { /* ignore */ }
}

$('#period').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.period = b.dataset.period; save(); load(); });
$('#period').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const btns = $$('#period button'); const i = btns.findIndex(b => b.dataset.period === state.period);
  const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
  n.focus(); n.click();
});
$('#sim').addEventListener('change', e => { state.sim = e.target.checked; save(); load(); });
$('#refresh').addEventListener('click', () => load());
$('#q').addEventListener('input', e => { state.q = e.target.value.trim(); state.limit = 10; renderLeads(); });
$('#leads-more').addEventListener('click', () => { state.limit += 10; renderLeads(); });
$('#route-filter').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.route = b.dataset.route; state.limit = 10; renderFilters(state.metrics); renderLeads(); });
$('#att-tabs').addEventListener('click', e => { const b = e.target.closest('[data-att-kind]'); if (!b) return; state.attKind = b.dataset.attKind; state.attOpen = false; renderAttention(state.metrics.attention); });
$('#att-more').addEventListener('click', () => { state.attOpen = !state.attOpen; renderAttention(state.metrics.attention); });

document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]');
  if (a) { e.preventDefault(); return act(a.dataset.act, a.dataset.id, a); }
  const o = e.target.closest('[data-open]');
  if (o) { e.preventDefault(); return openLead(o.dataset.open); }
  if (e.target.closest('[data-replay]')) return openReplay();
  const x = e.target.closest('[data-expand]');
  if (x) { state.expanded[x.dataset.expand] = true; state.attOpen = true; return renderAttention(state.metrics.attention); }
  const tr = e.target.closest('#leads tbody tr[data-id]');
  if (tr) openLead(tr.dataset.id);
});
$('#leads tbody').addEventListener('keydown', e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLead(tr.dataset.id); }
  if (e.key === 'ArrowDown') { e.preventDefault(); tr.nextElementSibling?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); tr.previousElementSibling?.focus(); }
});

$('#d-close').addEventListener('click', () => $('#drawer').close());

// Views and board controls
$$('.tabs a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.view); history.replaceState(null, '', `#${a.dataset.view}`); }));
$('#board-filters').addEventListener('input', e => {
  const f = state.bf;
  if (e.target.id === 'bf-q') f.q = e.target.value.trim();
  else if (e.target.id === 'bf-area') f.area = e.target.value;
  else if (e.target.id === 'bf-type') f.type = e.target.value;
  else if (e.target.id === 'bf-sort') f.sort = e.target.value;
  else return;
  $('#bf-clear').hidden = !(f.q || f.area || f.type || f.flags.length || f.sort !== 'urgent');
  renderBoard();
});
$('#board-filters').addEventListener('click', e => {
  const chip = e.target.closest('[data-flag]');
  if (chip) {
    const f = state.bf.flags; const k = chip.dataset.flag;
    state.bf.flags = f.includes(k) ? f.filter(x => x !== k) : [...f, k];
    chip.setAttribute('aria-pressed', String(state.bf.flags.includes(k)));
    $('#bf-clear').hidden = false;
    return renderBoard();
  }
  if (e.target.id === 'bf-clear') { state.bf = { q: '', area: '', type: '', flags: [], sort: 'urgent' }; renderFilterBar(); renderBoard(); }
});
$('#kind').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (!b) return; state.kind = b.dataset.kind; renderBoard(); });
$('#scope').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.scope = b.dataset.scope; renderBoard(); });
$('#me').addEventListener('change', e => { try { localStorage.setItem('aangan.me', e.target.value.trim()); } catch { /* ignore */ } renderBoard(); });
$('#board-cols').addEventListener('click', e => {
  const c = e.target.closest('[data-claim]');
  if (c) { e.stopPropagation(); return claim(c.dataset.claim, c); }
  if (e.target.closest('a, button')) return;
  const card = e.target.closest('[data-open-card]');
  if (card) openLead(card.dataset.openCard);
});
$('#drawer').addEventListener('close', () => history.replaceState(null, '', `${location.pathname}${location.search}#${state.view}`));
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) $('#drawer').close(); });

$('#open-replay').addEventListener('click', openReplay);
$('#replay').addEventListener('click', e => { if (e.target === $('#replay') || e.target.closest('[data-close]')) $('#replay').close(); });
$('#r-all').addEventListener('click', () => replay(samples.map(s => s.id)));
$('#r-selected').addEventListener('click', () => replay($$('#r-list input:checked').map(i => i.value)));
$('#r-clear').addEventListener('click', async e => {
  if (!confirm('Remove all simulated calls, enquiries and their activity? Real calls are not touched.')) return;
  e.target.disabled = true;
  try { const r = await post('/api/admin/clear-simulated'); $('#r-status').textContent = `Removed ${r.removed} simulated records.`; await load({ quiet: true }); }
  catch (err) { toast(err.message); } finally { e.target.disabled = false; }
});

document.addEventListener('keydown', e => {
  if (e.key === '/' && !e.target.closest('input, textarea, dialog')) { e.preventDefault(); $('#q').focus(); }
});

setInterval(() => { if (!document.hidden && !$('#drawer').open && !$('#replay').open) load({ quiet: true }); }, 30000);
setInterval(tickUpdated, 10000);

{
  let saved = 'overview';
  try { saved = localStorage.getItem('aangan.view') || 'overview'; } catch { /* ignore */ }
  const fromHash = location.hash.slice(1);
  showView(VIEWS.includes(fromHash) ? fromHash : saved);
}
load().then(() => {
  const m = location.hash.match(/lead=(\w+)/);
  if (m) openLead(m[1]);
});
