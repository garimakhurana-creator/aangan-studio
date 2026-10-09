// Aangan Studio — front desk.
// Leads: a photo-led gallery for the whole design team, filtered by what needs
// doing. Clicking a lead opens everything needed for the call: an opening line,
// what the caller already said, what to confirm, and a place to log the outcome.
// Insights: the founder's numbers. Every figure has a definition on hover.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const icon = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const num = n => Number(n || 0).toLocaleString('en-IN');
const inr = n => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const def = text => `<button type="button" class="def" data-def="${esc(text)}" aria-label="${esc(text)}">i</button>`;
const IST = { timeZone: 'Asia/Kolkata' };
const dayMonth = iso => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...IST });
const timeOf = iso => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', ...IST });
const weekday = iso => new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', ...IST });
const duration = s => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d < 7 ? `${d} day${d > 1 ? 's' : ''} ago` : dayMonth(iso);
}

// ---------------------------------------------------------------- brand imagery
// One Aangan image frames every lead (Unsplash License, credited in the footer);
// leads themselves are clean text cards.
const BRAND_IMG = 'photo-1773847469674-189153e5e32d';
const img = (id, w) => `https://images.unsplash.com/${id}?w=${w}&q=75&auto=format&fit=crop`;

// ---------------------------------------------------------------- vocabulary
const SCOPE = { full_home: 'Full home', partial: 'Some rooms', single_room: 'One room', office_fitout: 'Office fit-out' };
const DECIDER = { self: 'The caller', authorised: 'The caller, with their partner', proxy_decider_will_attend: 'The owners (caller is family)', research_only: 'Someone else — confirm who' };
const REASON = {
  OUT_OF_AREA: 'Outside Pune and PCMC', ADVICE_ONLY: 'Wanted advice only', SEGMENT_OUT_OF_SCOPE: 'Restaurant, shop or gym',
  BELOW_MIN_SIZE: 'Space too small', BUDGET_MISALIGNED: 'Budget far too low', TIMELINE_TOO_SHORT: 'Timeline too short', SITE_NOT_READY: 'Site not ready',
};
const HEADS_UP = {
  pricing_asked: "Asked about price. The assistant gave no figure, so pricing is yours to walk through at the consultation.",
  vip_referral: 'Referred by a friend of Nikhil.',
  repeat_caller: "Called before and wasn't followed up. Open with an apology.",
  proxy_caller: 'Calling for the owners. Make sure the decision-makers come to the consultation.',
  rented: 'Rented home: keep it reversible, no structural work.',
  large_project: 'Large project: suggest the principal designer visits the site.',
  tight_timeline: 'Tight timeline: confirm the completion date is firm.',
  structural_request: "Mentioned structural work, which the studio doesn't do.",
};
const OUTCOMES = [['booked', 'Booked a consultation'], ['no_answer', 'No answer'], ['callback', 'Call back later'], ['not_interested', 'Not interested'], ['not_fit', 'Not a fit']];
const OUTCOME_LABEL = Object.fromEntries([...OUTCOMES, ['note', 'Note']]);

// ---------------------------------------------------------------- state
const state = { view: 'leads', period: 'all', sim: false, simAuto: false, filter: null, q: '', area: '', type: '', flags: [], sort: 'urgent', leads: [], metrics: null, health: null, filtersOpen: false };
try {
  state.period = localStorage.getItem('aangan.period') || 'all';
  const s = localStorage.getItem('aangan.sim');
  state.sim = s === '1';
  state.simAuto = s === null; // decide after first load
} catch { /* storage unavailable */ }
const qs = new URLSearchParams(location.search);
if (qs.has('sim')) { state.sim = qs.get('sim') === '1'; state.simAuto = false; }
if (['7d', '30d', 'month', 'all'].includes(qs.get('period'))) state.period = qs.get('period');
if (qs.get('filter')) state.filter = qs.get('filter');
const save = () => { try { localStorage.setItem('aangan.period', state.period); localStorage.setItem('aangan.sim', state.sim ? '1' : '0'); } catch { /* ignore */ } };

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}

// ---------------------------------------------------------------- lead status
function urgency(l) {
  const d = l.decision || {}; const f = d.flags || [];
  const r = [];
  if (f.includes('vip_referral')) r.push('VIP: referred by a friend of Nikhil');
  if (f.includes('repeat_caller') || (f.includes('known_caller') && d.priority === 'high')) r.push("Called before and wasn't followed up");
  if (f.includes('tight_timeline')) r.push(`Tight timeline${l.timeline?.weeks_until_needed ? `, about ${l.timeline.weeks_until_needed} weeks` : ''}`);
  if (l.work?.status === 'callback' && l.work.callback_at && new Date(l.work.callback_at) <= Date.now() + 36e5) r.unshift(`Callback due ${timeOf(l.work.callback_at)}`);
  return r;
}

// One status per lead: what the team should do with it.
function statusOf(l) {
  const route = l.decision?.route;
  if (route === 'escalate') return { bucket: 'needs', label: 'Existing client', dot: 'crit', why: l.complaint?.detail || 'Unhappy existing client — senior callback due', hot: true };
  if (route === 'review') return { bucket: 'needs', label: 'Needs review', dot: 'warn', why: (l.decision.review_reasons || []).join(' '), hot: true };
  if (route === 'qualified') {
    if (l.work?.status === 'closed') return { bucket: 'notq', label: 'Closed', dot: 'muted', why: l.work.closed_reason === 'not_fit' ? 'Not a fit after the call' : 'Not interested after the call' };
    if (l.booking?.status === 'booked') return { bucket: 'booked', label: l.booking.start_time ? `Booked · ${dayMonth(l.booking.start_time)}` : 'Booked', dot: 'good', why: l.booking.start_time ? `${weekday(l.booking.start_time)}, ${timeOf(l.booking.start_time)}${l.site_visit ? ' · site visit' : ''}` : 'Consultation booked' };
    const u = urgency(l);
    if (u.length) return { bucket: 'needs', label: 'Urgent', dot: 'crit', why: u[0], hot: true };
    if (l.work?.status === 'callback') return { bucket: 'progress', label: `Callback ${dayMonth(l.work.callback_at)}`, dot: 'warn', why: `Call back ${weekday(l.work.callback_at)}, ${timeOf(l.work.callback_at)}` };
    if (l.work?.attempts) return { bucket: 'progress', label: 'Tried calling', dot: 'warn', why: `${l.work.attempts} ${l.work.attempts > 1 ? 'tries' : 'try'}, no answer yet` };
    if (l.booking?.status === 'link_sent') return { bucket: 'progress', label: 'Link sent', dot: 'warn', why: 'Booking link sent — waiting for them to pick a time' };
    const days = Math.floor((Date.now() - new Date(l.last_call_at)) / 864e5);
    return { bucket: 'new', label: 'New', dot: 'new', why: days >= 1 ? `Waiting ${days} day${days > 1 ? 's' : ''} for a call` : 'Called today' };
  }
  if (route === 'nurture') return { bucket: 'notq', label: 'Follow up later', dot: 'muted', why: l.reason || 'Timeline too short for now' };
  if (route === 'no_conversation') return { bucket: 'notq', label: 'No conversation', dot: 'muted', why: 'Hung up before saying anything' };
  return { bucket: 'notq', label: 'Not a fit', dot: 'muted', why: l.reason || 'Outside what the studio takes on' };
}
const tagOf = l => { const f = l.decision?.flags || []; return f.includes('vip_referral') ? 'VIP' : f.includes('large_project') ? 'Large' : f.includes('repeat_caller') ? 'Repeat' : ''; };
const nameOf = l => l.name || (l.phone ? `Caller ···${String(l.phone).replace(/\D/g, '').slice(-4)}` : 'Caller');

// ---------------------------------------------------------------- load & render
async function load({ quiet = false } = {}) {
  const q = `?period=${state.period}${state.sim ? '&simulated=1' : ''}`;
  if (!quiet) $('main').classList.add('loading');
  try {
    const [m, leads, health] = await Promise.all([api(`/api/metrics${q}`), api(`/api/leads${q}`), api('/api/health')]);
    // First visit with no real calls yet: show the demo calls automatically.
    if (state.simAuto && !state.sim && leads.length === 0) { state.sim = true; state.simAuto = false; return load({ quiet }); }
    state.simAuto = false;
    Object.assign(state, { metrics: m, leads, health });
    render();
  } catch (err) {
    toast(`Couldn't load: ${err.message}`);
  } finally {
    $('main').classList.remove('loading');
  }
}

function render() {
  $('#period').value = state.period;
  $('#sim').checked = state.sim;
  $('#demo-pill').hidden = !state.sim;
  renderLeads();
  renderInsights();
}

// ---------------------------------------------------------------- leads view
const CHIPS = [['needs', 'Needs you'], ['new', 'New'], ['progress', 'In progress'], ['booked', 'Booked'], ['notq', 'Not qualified'], ['all', 'All']];

function filtered() {
  const f = state;
  return state.leads.filter(l => {
    if (f.area && areaOf(l) !== f.area) return false;
    if (f.type && typeOf(l) !== f.type) return false;
    if (f.flags.length && !f.flags.every(x => (l.decision?.flags || []).includes(x))) return false;
    if (f.q) {
      const hay = [l.name, l.phone, l.project?.locality, l.project?.property_type, l.summary].join(' ').toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
}
const areaOf = l => String(l.project?.locality || '').split(/[,·—-]/)[0].trim();
const typeOf = l => (l.project?.segment === 'commercial' ? 'office' : l.project?.segment === 'residential' ? 'home' : 'other');

function renderLeads() {
  const leads = filtered();
  const by = { needs: [], new: [], progress: [], booked: [], notq: [], all: leads };
  for (const l of leads) { l._s = statusOf(l); by[l._s.bucket].push(l); }
  if (!state.filter) state.filter = by.needs.length ? 'needs' : by.new.length ? 'new' : 'all';

  const hour = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, ...IST }));
  $('#today').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', ...IST });
  $('#hello').textContent = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const parts = [[by.needs.length, 'need you'], [by.new.length, 'new'], [by.booked.length, 'booked']];
  $('#lede').innerHTML = state.leads.length ? parts.map(([n, t]) => `<b>${n}</b> ${t}`).join('<span class="sep"> · </span>') : 'No enquiries in this period yet.';

  $('#chips').innerHTML = CHIPS.map(([k, label]) => `<button type="button" role="tab" aria-selected="${state.filter === k}" data-chip="${k}">${k === 'needs' && by.needs.length ? '<span class="dot"></span>' : ''}${label} <span class="n">${by[k].length}</span></button>`).join('');

  const nf = (state.area ? 1 : 0) + (state.type ? 1 : 0) + state.flags.length + (state.sort !== 'urgent' ? 1 : 0);
  $('#fcount').hidden = !nf; $('#fcount').textContent = nf;
  renderFiltersPanel();

  let list = by[state.filter] || leads;
  const rank = { urgent: 0, high: 1, normal: 2 };
  const sorters = {
    urgent: (a, b) => (rank[a.decision?.priority] ?? 2) - (rank[b.decision?.priority] ?? 2) || a.last_call_at.localeCompare(b.last_call_at),
    newest: (a, b) => b.last_call_at.localeCompare(a.last_call_at),
    size: (a, b) => (b.project?.carpet_area_sqft || 0) - (a.project?.carpet_area_sqft || 0),
  };
  list = [...list].sort(state.filter === 'booked' && state.sort === 'urgent'
    ? (a, b) => String(a.booking?.start_time).localeCompare(String(b.booking?.start_time))
    : sorters[state.sort] || sorters.urgent);

  $('#cards').innerHTML = list.map(card).join('');
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = state.leads.length
      ? `<h3>${state.filter === 'needs' ? 'Nothing needs you' : 'Nothing here'}</h3><p>${state.filter === 'needs' ? 'Every urgent enquiry has been handled.' : 'Try another filter.'}</p>`
      : `<h3>No enquiries yet</h3><p>Calls to the studio appear here a minute after they end. To see how it works, replay September's calls.</p><button class="btn" type="button" data-open-demo>Replay demo calls</button>`;
  }
}

function card(l) {
  const s = l._s; const p = l.project || {};
  const tag = tagOf(l);
  const project = [p.property_type, p.locality].filter(Boolean).join(' · ') || 'Details in the brief';
  const foot = [p.carpet_area_sqft ? `${num(p.carpet_area_sqft)} sq ft` : null, SCOPE[p.scope_type], l.simulated ? 'Demo' : null].filter(Boolean);
  return `<button type="button" class="lcard b-${s.bucket}" data-open="${esc(l.id)}" aria-label="${esc(nameOf(l))}, ${esc(s.label)}">
    <span class="lc-top"><span class="badge"><span class="sdot k-${s.dot}"></span>${esc(s.label)}</span>${tag ? `<span class="tagr">${tag}</span>` : ''}<span class="lc-date">${esc(dayMonth(l.last_call_at))}</span></span>
    <span class="nm">${esc(nameOf(l))}</span>
    <span class="pj">${esc(project)}</span>
    <span class="why ${s.hot ? 'hot' : ''}">${esc(s.why)}</span>
    ${foot.length ? `<span class="ft">${foot.map(esc).join('<i>·</i>')}</span>` : ''}
  </button>`;
}

const FLAG_FILTERS = [['vip_referral', 'VIP'], ['repeat_caller', 'Called before'], ['site_visit_requested', 'Wants site visit'], ['pricing_asked', 'Asked price'], ['tight_timeline', 'Tight timeline'], ['rented', 'Rented'], ['large_project', 'Large project']];
function renderFiltersPanel() {
  const panel = $('#filters-panel');
  panel.hidden = !state.filtersOpen;
  $('#more-filters').setAttribute('aria-expanded', String(state.filtersOpen));
  if (!state.filtersOpen || panel.contains(document.activeElement)) return;
  const areas = [...new Set(state.leads.map(areaOf).filter(Boolean))].sort();
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`;
  panel.innerHTML = `
    <label class="fgroup"><span>Area</span><select id="f-area">${opt('', 'All areas', state.area)}${areas.map(a => opt(a, a, state.area)).join('')}</select></label>
    <label class="fgroup"><span>Type</span><select id="f-type">${opt('', 'Homes and offices', state.type)}${opt('home', 'Homes', state.type)}${opt('office', 'Offices', state.type)}</select></label>
    <label class="fgroup"><span>Sort</span><select id="f-sort">${opt('urgent', 'Most urgent first', state.sort)}${opt('newest', 'Newest first', state.sort)}${opt('size', 'Largest space first', state.sort)}</select></label>
    <div class="fgroup"><span>Only show</span><div class="flags">${FLAG_FILTERS.map(([k, t]) => `<button type="button" aria-pressed="${state.flags.includes(k)}" data-flag="${k}">${t}</button>`).join('')}</div></div>
    <button type="button" class="link" id="f-clear">Clear</button>`;
}

// ---------------------------------------------------------------- lead detail
// Only the most recently requested lead may render, so a slow response can
// never swap the panel to another lead (and a call can't be logged on the wrong person).
let openSeq = 0;
async function openLead(id) {
  const seq = ++openSeq;
  state.openId = id;
  let l;
  try { l = await api(`/api/leads/${id}`); } catch (err) { return toast(err.message); }
  if (seq !== openSeq) return;
  const listLead = state.leads.find(x => x.id === id) || l;
  const s = statusOf({ ...listLead, ...l, project: l.extraction?.project, timeline: listLead.timeline, complaint: listLead.complaint, reason: listLead.reason });
  const x = l.extraction || {}; const p = x.project || {}; const t = x.timeline || {}; const d = l.decision || {};
  const ph = BRAND_IMG;
  const qualifiedOpen = d.route === 'qualified' && !['closed'].includes(l.work?.status);
  const where = [p.locality, p.city].filter(Boolean).join(', ');

  const told = [
    ['Project', [p.property_type, SCOPE[p.scope_type]].filter(Boolean).join(' · ')],
    ['Rooms', (p.rooms || []).join(', ')],
    ['Where', where],
    ['Size', p.carpet_area_sqft ? `${num(p.carpet_area_sqft)} sq ft carpet` : ''],
    ['As it is now', p.current_state],
    ['Timeline', t.needed_by_text || t.preferred_start_text],
    ['Who decides', DECIDER[x.decision_maker?.status] || x.decision_maker?.detail],
    ['Consultation', [x.requests?.site_visit ? 'Site visit' : '', x.requests?.preferred_slots].filter(Boolean).join(' · ')],
    ['Found us', [x.referral?.how_found, x.referral?.referrer_name].filter(Boolean).join(' — ')],
    ['Phone', l.phone], ['Email', l.email],
  ].filter(([, v]) => v);
  // Pricing and budget wait for the consultation, so they're not on the call checklist.
  const confirm = [...new Set(d.confirm_at_consultation || [])].filter(q => !/budget|price|cost|afford/i.test(q));
  const heads = (d.flags || []).map(f => HEADS_UP[f]).filter(Boolean);
  const quotes = (x.evidence || []).map(e => e.quote).filter(q => q && q.trim().split(/s+/).length >= 4).slice(0, 2);
  const first = String(x.caller_name || l.name || '').split(/\s+/)[0];
  const opening = `Hi${first ? ` ${first}` : ''}, this is [your name] from Aangan Studio.${(d.flags || []).includes('repeat_caller') ? " First, I'm sorry nobody got back to you earlier — that shouldn't have happened." : ''} You spoke to our assistant on ${weekday(l.last_call_at)} about your ${[p.property_type, p.locality ? `in ${p.locality}` : ''].filter(Boolean).join(' ') || 'project'}, so I already have your details.${(d.flags || []).includes('proxy_caller') ? ' Could we find a time when the owners can join us too?' : " I'd love to set up a time to see the space."}`;

  const actions = [
    l.phone ? `<a class="btn" href="tel:${esc(l.phone.replace(/\s/g, ''))}">${icon('phone')}Call ${esc(l.phone)}</a>` : '',
    where ? `<a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${where}, Pune`)}" target="_blank" rel="noopener">${icon('pin')}Map</a>` : '',
    d.route === 'qualified' ? `<a class="btn ghost" href="/api/leads/${esc(id)}/brief" target="_blank" rel="noopener">${icon('mail')}Designer email</a>` : '',
    d.route === 'review' ? `<button class="btn good" data-act="approve" data-id="${esc(id)}">Send to the design team</button><button class="btn ghost" data-act="decline" data-id="${esc(id)}">Decline</button>` : '',
    d.route === 'escalate' && !l.handled_at ? `<button class="btn ghost" data-act="handled" data-id="${esc(id)}">Mark handled</button>` : '',
  ].join('');

  $('#d-content').innerHTML = `
    <div class="d-hero">
      <img src="${img(ph, 1400)}" alt="">
      <button type="button" class="icon-btn" data-close-drawer aria-label="Close">${icon('x')}</button>
      <div class="cap">
        <span class="badge"><span class="sdot k-${s.dot}"></span>${esc(s.label)}</span>
        <h2 id="d-title">${esc(nameOf(l))}</h2>
        <p>${esc([p.property_type, where].filter(Boolean).join(' · ') || 'Enquiry')}${l.simulated ? ' · Demo call' : ''}</p>
      </div>
    </div>
    ${actions ? `<div class="d-actions">${actions}</div>` : ''}
    <div class="d-body">
      <p class="d-summary">${esc(x.summary || '')}</p>

      ${d.route === 'escalate' ? `<section class="d-sec"><h3>What happened</h3><p class="reason">${esc(x.complaint?.detail || x.summary || '')}</p>${x.complaint?.designer_named ? `<p class="told-line"><span>Their designer:</span> ${esc(x.complaint.designer_named)}</p>` : ''}<p class="told-line"><span>They were told:</span> someone senior will call back within 15 minutes. Nikhil has been alerted.</p></section>` : ''}

      ${['declined', 'nurture', 'no_conversation'].includes(d.route) || l.work?.status === 'closed' ? `<section class="d-sec"><h3>Why it isn't a lead</h3><p class="reason">${esc(statusOf({ ...listLead }).why)}</p>${d.caller_line ? `<p class="told-line"><span>They were told:</span> “${esc(d.caller_line)}”</p>` : ''}</section>` : ''}

      ${d.route === 'review' ? `<section class="d-sec"><h3>Why it needs a decision</h3><p class="reason">${esc((d.review_reasons || []).join(' '))}</p></section>` : ''}

      ${qualifiedOpen ? `<section class="say"><span class="k">Open with</span><p id="opening">${esc(opening)}</p><button type="button" data-copy="opening">${icon('copy')}Copy</button></section>` : ''}

      ${told.length && d.route !== 'no_conversation' ? `<section class="d-sec"><h3>They already told us</h3><dl class="facts">${told.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>` : ''}

      ${qualifiedOpen && confirm.length ? `<section class="d-sec"><h3>Confirm on the call</h3><ul class="list">${confirm.map(c => `<li>${icon('check')}<span>${esc(c)}</span></li>`).join('')}</ul></section>` : ''}
      ${qualifiedOpen && heads.length ? `<section class="d-sec"><h3>Good to know</h3><ul class="list heads">${heads.map(h => `<li>${icon('alert')}<span>${esc(h)}</span></li>`).join('')}</ul></section>` : ''}
      ${quotes.length ? `<section class="d-sec"><h3>In their words</h3>${quotes.map(q => `<q class="quote">${esc(q)}</q>`).join('')}</section>` : ''}

      ${d.route === 'qualified' ? `<section class="d-sec"><h3>Log the call</h3>
        <form class="oc-form" data-outcome="${esc(id)}">
          <div class="oc-choices" role="radiogroup" aria-label="How did the call go">${OUTCOMES.map(([k, label]) => `<label class="oc"><input type="radio" name="oc" value="${k}" required><span>${label}</span></label>`).join('')}</div>
          <div class="oc-row"><label class="oc-when" hidden>When <input type="datetime-local" name="when"></label><input type="text" name="by" placeholder="Your name (optional)" maxlength="60" value="${esc(localStorage.getItem('aangan.me') || '')}"></div>
          <textarea name="note" rows="2" maxlength="1000" placeholder="Note for the team (optional)"></textarea>
          <div class="oc-row"><button class="btn" type="submit">Save</button><span class="sub" role="status"></span></div>
        </form>
        ${(l.notes || []).length ? `<ul class="history" style="margin-top:16px">${l.notes.slice().reverse().map(n => `<li><span class="t">${esc(ago(n.at))}${n.by && n.by !== 'A designer' ? ` · ${esc(n.by)}` : ''}</span><b>${esc(OUTCOME_LABEL[n.outcome] || n.outcome)}</b>${n.when ? ` — ${esc(weekday(n.when))} ${esc(dayMonth(n.when))}, ${esc(timeOf(n.when))}` : ''}${n.text ? `<br>${esc(n.text)}` : ''}</li>`).join('')}</ul>` : ''}
      </section>` : ''}

      <details class="more"><summary>How the assistant decided</summary><div>
        ${Object.values(d.criteria || {}).map(c => `<div class="crit"><span class="mk ${c.status}">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '?'}</span><div>${esc(c.name)}<br><span>${esc(c.reason)}</span></div></div>`).join('') || '<p class="sub">Not assessed: this wasn\'t a new enquiry.</p>'}
        <div class="checks" style="margin-top:14px">
          <div>${l.factcheck?.ok ? '<span class="ok">✓</span> The assistant stayed on script: no prices, no invented facts.' : `<span class="bad">!</span> ${esc((l.factcheck?.violations || []).map(v => `${v.type.replace(/_/g, ' ')}: “${v.text.slice(0, 120)}”`).join(' · '))}`}</div>
          <div>${(l.grounding_warnings || []).length ? `<span class="bad">!</span> Removed ${l.grounding_warnings.length} detail(s) the caller never said.` : '<span class="ok">✓</span> Every detail above was said on the call.'}</div>
        </div>
      </div></details>
      <details class="more"><summary>Activity</summary><div><ul class="timeline">${(l.events || []).map(e => `<li><span class="t">${esc(timeOf(e.at))}</span>${esc(eventLabel(e))}${e.status !== 'ok' ? ` — ${esc(e.status === 'skipped' ? 'not connected yet' : e.error || e.status)}` : ''}</li>`).join('')}</ul></div></details>
      <details class="more"><summary>Transcript</summary><div><pre class="transcript">${esc(l.transcript)}</pre>${l.recording_url ? `<p style="margin-top:10px"><a href="${esc(l.recording_url)}" target="_blank" rel="noopener">Listen to the recording</a></p>` : ''}</div></details>
    </div>`;
  const dlg = $('#drawer');
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  history.replaceState(null, '', `#lead=${id}`);
}

function eventLabel(e) {
  return {
    decision: `Assistant decided: ${e.result?.route === 'qualified' ? 'qualified' : e.result?.route || ''}`, hubspot: 'Saved to HubSpot', calendly: 'Booking link created',
    email_caller: 'Booking link emailed to caller', email_designer: 'Brief emailed to the design team', telegram: 'Nikhil alerted on Telegram',
    handoff_accepted: 'Picked up by a designer', booked: 'Consultation booked', review_decision: 'Decision on review', marked_handled: 'Marked handled',
    designer_outcome: e.detail || 'Call logged',
  }[e.type] || e.type.replace(/_/g, ' ');
}

// ---------------------------------------------------------------- insights
function renderInsights() {
  const m = state.metrics; if (!m) return;
  const r = m.response;
  const q = m.funnel.find(f => f.key === 'qualified').value;
  const calls = r.calls.value;
  const ah = r.after_hours.value;
  $('#stats').innerHTML = [
    ['Calls answered', calls ? '100%' : '—', calls ? `${num(calls)} calls, none missed` : 'No calls yet', r.answered_pct.def],
    ['After hours', num(ah), calls ? `${Math.round(ah / calls * 100)}% of calls, all answered` : '—', r.after_hours.def],
    ['Qualified', num(q), `of ${num(m.funnel[0].value)} enquiries`, m.funnel[1].def],
    ['Cost per qualified lead', inr(m.cost.per_qualified_inr), m.cost.rates_missing.length ? 'Add rates in config/costs.json' : 'Voice + AI', m.cost.def],
  ].map(([k, v, n, d]) => `<div class="stat"><span class="k">${esc(k)} ${def(d)}</span><span class="v">${esc(v)}</span><span class="n">${esc(n)}</span></div>`).join('');

  renderHourly(m);
  const b = m.baseline;
  $('#ba').innerHTML = `<h2>Before and now</h2><div class="big2">
    <div class="then"><span class="k">Last month, by hand</span><span class="v">${b.no_reply_48h_pct}%</span><p>of ~${b.enquiries_per_month} enquiries had no reply after 48 hours.</p></div>
    <div class="now"><span class="k">With the front desk</span><span class="v">${calls ? '0%' : '—'}</span><p>unanswered. Every call is picked up live, day or night.</p></div></div>`;

  const f = m.funnel; const top = Math.max(1, f[0].value);
  $('#funnel').innerHTML = `<div class="bars">${f.map((s, i) => `${i ? `<div class="conv">↓ ${f[i - 1].value ? Math.round(s.value / f[i - 1].value * 100) + '%' : '—'}</div>` : ''}<div class="bar-row"><span class="nm">${esc(s.label)}</span><span class="bar"><i style="width:${s.value / top * 100}%"></i></span><span class="n">${num(s.value)}</span></div>`).join('')}</div>`;

  const routes = [['qualified', 'Qualified'], ['declined', 'Not a fit'], ['nurture', 'Follow up later'], ['escalate', 'Existing clients'], ['review', 'Needs review'], ['no_conversation', 'No conversation']].map(([k, label]) => ({ label, value: m.routes[k] || 0 }));
  const reasons = Object.entries(m.decline_reasons).filter(([k]) => REASON[k]).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => ({ label: REASON[k], value: v }));
  const max = Math.max(1, ...routes.map(x => x.value));
  const bars = items => `<div class="bars">${items.map(i => `<div class="bar-row"><span class="nm">${esc(i.label)}</span><span class="bar"><i style="width:${i.value / max * 100}%"></i></span><span class="n">${num(i.value)}</span></div>`).join('')}</div>`;
  $('#routes').innerHTML = bars(routes) + (reasons.length ? `<p class="sub" style="margin-top:8px">Why some weren't a fit</p>${bars(reasons)}` : '');

  const p = m.pricing; const quoted = m.health.pricing_quotes;
  $('#pricing').innerHTML = `<dl class="kv">
    <div><dt>Asked the price</dt><dd>${num(p.asked)}</dd></div>
    <div><dt>…still qualified</dt><dd>${num(p.asked_and_qualified)}</dd></div>
    <div><dt>…booked</dt><dd>${num(p.asked_and_booked)}</dd></div>
    <div><dt>Prices quoted ${def('Any figure or rate the assistant said, caught by the post-call fact-check.')}</dt><dd class="${quoted ? 'bad' : 'good'}">${num(quoted)}</dd></div></dl>
    <p class="note">Nikhil asked for instant per-sq-ft quotes; his own pricing guide says never quote. The assistant gives his approved line and offers the free consultation.</p>`;

  const c = m.cost;
  $('#cost').innerHTML = `<dl class="kv">
    <div><dt>Per call</dt><dd>${inr(c.per_call_inr)}</dd></div>
    <div><dt>Per qualified lead</dt><dd>${inr(c.per_qualified_inr)}</dd></div>
    <div><dt>Per booking</dt><dd>${inr(c.per_booking_inr)}</dd></div>
    <div><dt>Voice ${def("Vaani's own per-call charge, in credits.")}</dt><dd>${num(c.vaani_credits)} cr</dd></div>
    <div><dt>AI ${def('Gemini tokens used to read each call.')}</dt><dd>${num(c.gemini_tokens.input + c.gemini_tokens.output)} tok</dd></div></dl>
    ${c.rates_missing.length ? `<p class="note">Usage is measured on every call. Add rates in config/costs.json to see rupees.</p>` : ''}`;

  const h = m.health;
  const row = (k, v, ok, d) => `<div><dt>${k}${d ? ` ${def(d)}` : ''}</dt><dd class="${ok ? 'good' : v ? 'bad' : ''}">${esc(v)}</dd></div>`;
  $('#health').innerHTML = `<dl class="kv">
    ${row('Transcript test', h.eval ? `${h.eval.passed}/${h.eval.total}` : '—', h.eval && h.eval.passed === h.eval.total, "September's 20 calls replayed against the expected outcome.")}
    ${row('Red-team', h.redteam ? `${h.redteam.passed}/${h.redteam.total}` : '—', h.redteam && h.redteam.passed === h.redteam.total, 'Callers trying to extract a price or bait the assistant into inventing facts.')}
    ${row('Off-script lines', h.factcheck_violations, h.factcheck_violations === 0, 'Anything the agent said that is not an approved fact.')}
    ${row('Failed actions', h.integration_failures, h.integration_failures === 0)}</dl>
    ${h.unconfirmed_policy.length ? `<p class="note">Waiting on Nikhil: ${esc(h.unconfirmed_policy.join(' · '))}.</p>` : ''}`;

  const hh = state.health;
  if (hh) {
    const items = [['Voice agent', hh.vaani.configured], ['AI', hh.gemini.configured], ['Database', hh.store === 'neon'], ['HubSpot', hh.integrations.hubspot], ['Calendly', hh.integrations.calendly], ['Email', hh.integrations.email], ['Telegram', hh.integrations.telegram]];
    $('#setup').innerHTML = `<div class="conn">${items.map(([k, v]) => `<span class="${v ? 'on' : ''}"><span class="cd"></span>${esc(k)}</span>`).join('')}</div><p class="sub">Anything not connected is logged as skipped and can be retried later; no enquiry is lost.</p>`;
  }
}

const hourLabel = h => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
function renderHourly(m) {
  const data = m.hourly.data;
  const total = data.reduce((s, d) => s + d.calls, 0);
  const after = data.filter(d => d.after_hours).reduce((s, d) => s + d.calls, 0);
  $('#hourly-sub').textContent = total ? `${after} of ${total} calls came while the front desk was closed.` : 'Calls by hour of day.';
  if (!total) { $('#hourly').innerHTML = '<p class="sub">Calls will appear here by hour of day.</p>'; $('#hourly-table').innerHTML = ''; return; }
  const W = 720, H = 220, L = 26, R = 4, T = 26, B = 24;
  const pw = W - L - R, ph = H - T - B, slot = pw / 24, bw = Math.min(18, slot * 0.56);
  const max = Math.max(4, ...data.map(d => d.calls));
  const y = v => T + ph - (v / max) * ph;
  const [open, close] = m.hourly.office_hours;
  const peak = data.reduce((a, d) => (d.calls > a.calls ? d : a), data[0]);
  const path = (x, top, bottom) => { const h2 = bottom - top; if (h2 <= 0) return ''; const r = Math.min(4, h2, bw / 2); return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bottom}Z`; };
  $('#hourly').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calls by hour; ${after} of ${total} outside 10am to 7pm">
    <rect class="band" x="${L + open * slot}" y="${T - 18}" width="${(close - open) * slot}" height="${ph + 18}" rx="8"/>
    <text class="band-label" x="${L + ((open + close) / 2) * slot}" y="${T - 6}" text-anchor="middle">Desk open</text>
    <line class="grid-line" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>
    ${data.map((d, i) => `<g><rect class="col-hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}" data-h="${d.hour}" data-c="${d.calls}" data-a="${d.after_hours ? 1 : 0}" tabindex="${d.calls ? 0 : -1}"/><path class="col" d="${path(L + i * slot + (slot - bw) / 2, y(d.calls), T + ph)}"/></g>`).join('')}
    ${peak.calls ? `<text class="val" x="${L + peak.hour * slot + slot / 2}" y="${y(peak.calls) - 6}" text-anchor="middle">${peak.calls}</text>` : ''}
    ${[0, 6, 12, 18, 23].map(h => `<text class="axis" x="${L + h * slot + slot / 2}" y="${H - 4}" text-anchor="middle">${hourLabel(h)}</text>`).join('')}
  </svg>`;
  $('#hourly-table').innerHTML = `<table><thead><tr><th>Hour</th><th>Calls</th><th>Desk</th></tr></thead><tbody>${data.filter(d => d.calls).map(d => `<tr><td>${hourLabel(d.hour)}</td><td>${d.calls}</td><td>${d.after_hours ? 'Closed' : 'Open'}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- tooltips
function showTip(el, html) {
  const tip = $('#tip'); tip.innerHTML = html; tip.hidden = false;
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2));
  let y = r.top - tip.offsetHeight - 8; if (y < 8) y = r.bottom + 8;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const tipHtml = el => (el.classList.contains('col-hit')
  ? `<b>${hourLabel(+el.dataset.h)}–${hourLabel((+el.dataset.h + 1) % 24)}</b>${el.dataset.c} call${el.dataset.c === '1' ? '' : 's'} · desk ${el.dataset.a === '1' ? 'closed' : 'open'}`
  : esc(el.dataset.def));
document.addEventListener('mouseover', e => { const t = e.target.closest('.col-hit, .def'); if (t) showTip(t, tipHtml(t)); });
document.addEventListener('mouseout', e => { if (e.target.closest('.col-hit, .def')) $('#tip').hidden = true; });
document.addEventListener('focusin', e => { const t = e.target.closest('.col-hit, .def'); if (t) showTip(t, tipHtml(t)); });
document.addEventListener('focusout', e => { if (e.target.closest('.col-hit, .def')) $('#tip').hidden = true; });
addEventListener('scroll', () => { $('#tip').hidden = true; }, { passive: true });

// ---------------------------------------------------------------- actions
async function act(action, id, el) {
  if (el) el.disabled = true;
  try {
    if (action === 'approve' || action === 'decline') { await post(`/api/leads/${id}/decide`, { choice: action }); toast(action === 'approve' ? 'Sent to the design team.' : 'Declined.'); }
    if (action === 'handled') { await post(`/api/leads/${id}/handled`); toast('Marked handled.'); }
    await load({ quiet: true });
    if (state.openId === id && $('#drawer').open) openLead(id);
  } catch (err) { toast(err.message); if (el) el.disabled = false; }
}

// ---------------------------------------------------------------- views
const VIEWS = ['leads', 'insights'];
function showView(v) {
  state.view = VIEWS.includes(v) ? v : 'leads';
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== state.view;
  $$('[data-nav]').forEach(a => (a.dataset.nav === state.view && a.closest('.nav') ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- demo
async function replayAll() {
  const samples = await api('/api/samples').catch(() => []);
  if (!samples.length) return toast('Demo transcripts are not available on this server.');
  const email = $('#r-email').value.trim() || undefined;
  const bar = $('#r-progress'), fill = bar.querySelector('i'), status = $('#r-status');
  bar.hidden = false; $('#r-all').disabled = true;
  for (let i = 0; i < samples.length; i++) {
    status.textContent = `Replaying ${i + 1} of ${samples.length}…`;
    await post('/api/simulate', { sample: samples[i].id, email }).catch(() => null);
    fill.style.width = `${((i + 1) / samples.length) * 100}%`;
  }
  status.textContent = 'Done. The calls are now in Leads.';
  $('#r-all').disabled = false;
  state.sim = true; save();
  await load({ quiet: true });
}

// ---------------------------------------------------------------- events
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); showView(nav.dataset.nav); history.replaceState(null, '', `#${state.view}`); return; }
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); return openLead(open.dataset.open); }
  const a = e.target.closest('[data-act]');
  if (a) return act(a.dataset.act, a.dataset.id, a);
  const chip = e.target.closest('[data-chip]');
  if (chip) { state.filter = chip.dataset.chip; return renderLeads(); }
  const flag = e.target.closest('[data-flag]');
  if (flag) { const k = flag.dataset.flag; state.flags = state.flags.includes(k) ? state.flags.filter(x => x !== k) : [...state.flags, k]; flag.setAttribute('aria-pressed', String(state.flags.includes(k))); return renderLeads(); }
  if (e.target.id === 'f-clear') { Object.assign(state, { area: '', type: '', flags: [], sort: 'urgent' }); $('#filters-panel').innerHTML = ''; return renderLeads(); }
  if (e.target.closest('#more-filters')) { state.filtersOpen = !state.filtersOpen; return renderLeads(); }
  if (e.target.closest('[data-close-drawer]')) return $('#drawer').close();
  if (e.target.closest('[data-open-demo]') || e.target.closest('#open-demo')) return $('#demo').showModal();
  if (e.target.closest('[data-close]')) return e.target.closest('dialog').close();
  const copy = e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard?.writeText($(`#${copy.dataset.copy}`).textContent).then(() => toast('Copied.'), () => toast('Copy not available.')); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'period') { state.period = e.target.value; save(); load(); }
  if (e.target.id === 'sim') { state.sim = e.target.checked; save(); load(); }
  if (e.target.id === 'f-area') { state.area = e.target.value; renderLeads(); }
  if (e.target.id === 'f-type') { state.type = e.target.value; renderLeads(); }
  if (e.target.id === 'f-sort') { state.sort = e.target.value; renderLeads(); }
  if (e.target.name === 'oc') {
    const when = e.target.closest('form').querySelector('.oc-when');
    when.hidden = !['booked', 'callback'].includes(e.target.value);
    when.querySelector('input').required = !when.hidden;
  }
});
$('#q').addEventListener('input', e => { state.q = e.target.value.trim(); renderLeads(); });
document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-outcome]');
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.outcome; const fd = new FormData(form);
  const status = form.querySelector('[role="status"]'); const btn = form.querySelector('button[type="submit"]');
  const by = String(fd.get('by') || '').trim();
  try { if (by) localStorage.setItem('aangan.me', by); } catch { /* ignore */ }
  btn.disabled = true; status.textContent = 'Saving…';
  try {
    const res = await post(`/api/leads/${id}/outcome`, { designer: by || 'Design team', outcome: fd.get('oc'), note: fd.get('note'), when: fd.get('when') ? new Date(fd.get('when')).toISOString() : undefined });
    toast({ booked: 'Consultation booked.', no_answer: 'Logged: no answer.', callback: 'Callback scheduled.', not_interested: 'Closed: not interested.', not_fit: 'Closed: not a fit.' }[fd.get('oc')] || 'Saved.');
    // Show the change straight away; the server copy follows in the background.
    const local = state.leads.find(x => x.id === id);
    if (local) Object.assign(local, { work: res.work, booking: res.booking, notes_count: res.notes.length });
    renderLeads();
    form.reset(); form.querySelector('.oc-when').hidden = true; btn.disabled = false; status.textContent = 'Saved.';
    const hist = form.parentElement.querySelector('.history') || form.insertAdjacentElement('afterend', Object.assign(document.createElement('ul'), { className: 'history', style: 'margin-top:16px' }));
    const n = res.notes.at(-1);
    hist.insertAdjacentHTML('afterbegin', `<li><span class="t">just now${n.by && n.by !== 'Design team' ? ` · ${esc(n.by)}` : ''}</span><b>${esc(OUTCOME_LABEL[n.outcome])}</b>${n.when ? ` — ${esc(weekday(n.when))} ${esc(dayMonth(n.when))}, ${esc(timeOf(n.when))}` : ''}${n.text ? `<br>${esc(n.text)}` : ''}</li>`);
    if (local) { const b = $('.d-hero .badge'); const s = statusOf(local); if (b) b.innerHTML = `<span class="sdot k-${s.dot}"></span>${esc(s.label)}`; }
    load({ quiet: true });
  } catch (err) { status.textContent = err.message; btn.disabled = false; }
});
$('#drawer').addEventListener('click', e => { if (e.target === $('#drawer')) $('#drawer').close(); });
$('#drawer').addEventListener('close', () => { state.openId = null; openSeq++; history.replaceState(null, '', `#${state.view}`); });
$('#r-all').addEventListener('click', replayAll);
$('#r-clear').addEventListener('click', async () => {
  if (!confirm('Remove all demo calls? Real calls are not touched.')) return;
  const r = await post('/api/admin/clear-simulated').catch(err => ({ error: err.message }));
  $('#r-status').textContent = r.error || `Removed ${r.removed} demo records.`;
  load({ quiet: true });
});
$('#csv').addEventListener('click', () => {
  const cols = ['Called', 'Name', 'Phone', 'Email', 'Project', 'Area', 'Status', 'Reason'];
  const rows = state.leads.map(l => { const s = statusOf(l); return [l.last_call_at, l.name, l.phone, l.email, l.project?.property_type, l.project?.locality, s.label, s.why]; });
  const csv = [cols, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'aangan-enquiries.csv' }).click();
});
setInterval(() => { if (!document.hidden && !$('#drawer').open && !$('#demo').open) load({ quiet: true }); }, 30000);

// ---------------------------------------------------------------- start
showView(location.hash.slice(1) === 'insights' ? 'insights' : 'leads');
load().then(() => { const m = location.hash.match(/lead=(\w+)/); if (m && openSeq === 0) openLead(m[1]); });
