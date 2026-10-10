// HTTP app, shared by the local server (server.js) and Vercel (api/index.js).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
require('./lib/env').loadDotEnv();
const { store } = require('./lib/store');
const { normalizeWebhook } = require('./lib/vaani');
const { processPostCall, runActions, acceptHandoff, sweep, logEvent, decideReview, markHandled, claimLead, recordOutcome } = require('./lib/pipeline');
const { designerHandoff } = require('./lib/templates');
const { computeMetrics, periodStart } = require('./lib/metrics');
const { requirePassword } = require('./lib/auth');
const { loadPolicy } = require('./lib/policy');
const llm = require('./lib/llm');
const integrations = {
  hubspot: require('./lib/integrations/hubspot'),
  calendly: require('./lib/integrations/calendly'),
  email: require('./lib/integrations/email'),
  telegram: require('./lib/integrations/telegram'),
};

const app = express();
app.use(express.json({ limit: '2mb' }));

// Background work: on Vercel, keep the function alive after responding.
function background(promise) {
  const p = promise.catch(err => console.error('[background]', err));
  try { require('@vercel/functions').waitUntil(p); } catch { /* local: fire and forget */ }
}

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ---------------------------------------------------------------- public

// Vaani posts call events here. The shared secret is in the URL because the
// Vaani docs don't describe request signing.
app.post('/api/vaani/webhook', async (req, res) => {
  const secret = process.env.VAANI_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'VAANI_WEBHOOK_SECRET not set' });
  if (!safeEq(req.query.key || '', secret)) return res.status(401).json({ error: 'bad key' });

  const w = normalizeWebhook(req.body);
  // Vaani's 'Test Connectivity' ping has no call; acknowledge it so the test passes.
  if (!w.call_id) return res.json({ status: 'ok', note: 'connected; no call in this event' });
  if (w.event === 'call_postprocessing') {
    res.json({ status: 'accepted' });
    // Hobby-plan cron runs daily, so also sweep SLA nudges whenever a call lands.
    return background(processPostCall(w).then(() => sweep()));
  }
  if (w.event === 'call_started' || w.event === 'call_ended') {
    const db = store();
    const call = (await db.get('calls', w.call_id)) || { id: w.call_id };
    if (w.phone) call.phone = w.phone;
    if (w.event === 'call_started') call.started_at = new Date().toISOString();
    if (w.duration_s != null) call.duration_s = w.duration_s;
    await db.put('calls', w.call_id, call);
  }
  res.json({ status: 'ok' });
});

app.get('/api/accept/:leadId/:token', async (req, res) => {
  const r = await acceptHandoff(req.params.leadId, req.params.token);
  const msg = r.ok
    ? `<h1>Thanks${r.lead.assigned_to?.name ? `, ${escapeHtml(r.lead.assigned_to.name.split(' ')[0])}` : ''} — it's yours.</h1><p>${escapeHtml(r.lead.name || 'The caller')} is marked as picked up${r.already ? ' (already accepted earlier)' : ''}. Nikhil won't be nudged about this one.</p>`
    : `<h1>Couldn't accept</h1><p>${escapeHtml(r.reason)}</p>`;
  res.status(r.ok ? 200 : 400).type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Aangan Studio</title><body style="font:16px/1.5 system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#1f2328">${msg}</body>`);
});

// Vercel Cron: SLA nudges and Calendly booking checks.
app.get('/api/cron/sweep', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();
  res.json(await sweep());
});

// ---------------------------------------------------------------- dashboard (password)

// Open by default (the owner chose a public demo). Setting DASHBOARD_PASSWORD turns the lock on.
app.use(requirePassword({ required: false }));

app.get('/api/health', (req, res) => {
  res.json({
    store: store().name,
    gemini: { configured: llm.isConfigured(), model: llm.model() },
    vaani: { configured: Boolean(process.env.VAANI_API_KEY), webhook_secret: Boolean(process.env.VAANI_WEBHOOK_SECRET) },
    integrations: Object.fromEntries(Object.entries(integrations).map(([k, v]) => [k, v.configured()])),
    designer_email: Boolean(process.env.DESIGNER_EMAIL),
    email_test_mode: Boolean(process.env.EMAIL_OVERRIDE_TO),
    policy_version: loadPolicy().version,
  });
});

const isSim = req => req.query.simulated === '1';
const PERIODS = new Set(['7d', '30d', 'month', 'all']);
const period = req => (PERIODS.has(req.query.period) ? req.query.period : 'all');

app.get('/api/metrics', async (req, res) => {
  const db = store();
  const [leads, calls, events] = await Promise.all([db.all('leads'), db.all('calls'), db.all('events')]);
  res.json(computeMetrics({ leads, calls, events, includeSimulated: isSim(req), period: period(req) }));
});

app.get('/api/leads', async (req, res) => {
  const start = periodStart(period(req));
  const leads = (await store().all('leads'))
    .filter(l => isSim(req) || !l.simulated)
    .filter(l => !start || new Date(l.last_call_at) >= start)
    .sort((a, b) => b.last_call_at.localeCompare(a.last_call_at))
    .map(({ transcript, extraction, ...l }) => ({
      ...l,
      summary: extraction?.summary,
      project: extraction?.project,
      timeline: extraction?.timeline ? { needed_by: extraction.timeline.needed_by_text, preferred_start: extraction.timeline.preferred_start_text, site_available: extraction.timeline.site_available_text, weeks_until_needed: extraction.timeline.weeks_until_needed } : null,
      decision_maker: extraction?.decision_maker ? { status: extraction.decision_maker.status, detail: extraction.decision_maker.detail } : null,
      complaint: extraction?.complaint?.is_existing_client ? { detail: extraction.complaint.detail, designer: extraction.complaint.designer_named } : null,
      site_visit: !!extraction?.requests?.site_visit,
      preferred_slots: extraction?.requests?.preferred_slots || null,
      reason: Object.values(l.decision?.criteria || {}).find(c => c.status === 'fail')?.reason || null,
      has_recording: !l.simulated,
      work: l.work || null,
      notes_count: (l.notes || []).length,
      last_note: (l.notes || []).at(-1) || null,
      handoff: { ...l.handoff, token_hash: undefined },
    }));
  res.json(leads);
});

app.get('/api/leads/:id', async (req, res) => {
  const lead = await store().get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const events = (await store().all('events')).filter(e => e.lead_id === lead.id).sort((a, b) => a.at.localeCompare(b.at));
  res.json({ ...lead, handoff: { ...lead.handoff, token_hash: undefined }, events });
});

app.post('/api/leads/:id/decide', async (req, res) => {
  const choice = req.body?.choice;
  if (!['approve', 'decline'].includes(choice)) return res.status(400).json({ error: 'choice must be approve or decline' });
  try {
    const lead = await decideReview(req.params.id, choice);
    res.json({ route: lead.decision.route, action_status: lead.action_status });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/leads/:id/outcome', async (req, res) => {
  try {
    const lead = await recordOutcome(req.params.id, req.body || {});
    res.json({ work: lead.work, booking: lead.booking, assigned_to: lead.assigned_to, notes: lead.notes });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/leads/:id/claim', async (req, res) => {
  try { const lead = await claimLead(req.params.id, req.body?.designer); res.json({ handoff: { ...lead.handoff, token_hash: undefined }, assigned_to: lead.assigned_to }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/leads/:id/handled', async (req, res) => {
  try { res.json({ handled_at: (await markHandled(req.params.id)).handled_at }); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// The designer email exactly as sent (accept link disabled in the preview).
// Streams a call recording from Vaani. Vaani needs the API key, so the browser
// can't fetch it directly; the key stays on the server. Range requests are
// passed through so the player can seek.
app.get('/api/leads/:id/recording', async (req, res) => {
  const lead = await store().get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  if (lead.simulated) return res.status(404).json({ error: 'Demo calls are typed transcripts, so there is no audio.' });
  const callId = req.query.call || lead.call_ids.at(-1);
  if (!lead.call_ids.includes(callId)) return res.status(400).json({ error: 'unknown call' });
  if (!process.env.VAANI_API_KEY) return res.status(503).json({ error: 'Vaani is not connected' });
  const headers = { 'X-API-Key': process.env.VAANI_API_KEY };
  if (req.headers.range) headers.Range = req.headers.range;
  try {
    const r = await fetch(`https://api.vaanivoice.ai/api/stream/${encodeURIComponent(callId)}`, { headers });
    if (!r.ok || !r.body) return res.status(r.status === 404 ? 404 : 502).json({ error: 'Recording not available yet' });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(r.status);
    require('stream').Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Vaani for the recording' });
  }
});

app.get('/api/leads/:id/brief', async (req, res) => {
  const lead = await store().get('leads', req.params.id);
  if (!lead || lead.decision.route !== 'qualified') return res.status(404).type('text').send('No designer brief for this enquiry.');
  const { subject, html } = designerHandoff({ lead, acceptUrl: '#preview', dashboardUrl: '#preview' });
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title><body style="margin:0;padding:24px 16px;background:#fff">${html}</body>`);
});

app.post('/api/leads/:id/retry', async (req, res) => {
  const lead = await store().get('leads', req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const after = await runActions(lead.id);
  res.json({ action_status: after.action_status });
});

// Replays a transcript as a call, labelled simulated everywhere. Lets the whole
// pipeline be demonstrated before a phone number is connected.
const TRANSCRIPTS = path.join(__dirname, 'eval', 'transcripts');
app.get('/api/samples', (req, res) => {
  if (!fs.existsSync(TRANSCRIPTS)) return res.json([]);
  res.json(fs.readdirSync(TRANSCRIPTS).filter(f => f.endsWith('.txt')).map(f => {
    const text = fs.readFileSync(path.join(TRANSCRIPTS, f), 'utf-8');
    return { id: f.replace('.txt', ''), header: text.split('\n')[0], preview: text.split('\n').slice(1, 4).join(' ').slice(0, 160) };
  }));
});

app.post('/api/simulate', async (req, res) => {
  const { sample, transcript, phone, email } = req.body || {};
  let text = transcript;
  let endedAt = new Date().toISOString();
  let precomputed = null;
  const id = String(sample || '').replace(/[^A-Z0-9]/gi, '');
  if (sample) {
    const file = path.join(TRANSCRIPTS, `${id}.txt`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'sample not found' });
    text = fs.readFileSync(file, 'utf-8');
    endedAt = sampleTime(text.split('\n')[0]) || endedAt;
    // Reuse the eval's extraction of this exact transcript: instant, no Gemini call.
    const cache = path.join(__dirname, 'eval', 'cache', `${id}.json`);
    if (fs.existsSync(cache)) {
      const c = JSON.parse(fs.readFileSync(cache, 'utf-8'));
      precomputed = { extraction: c.extraction, usage: c.usage };
    }
  }
  if (!text) return res.status(400).json({ error: 'sample or transcript required' });
  // Replaying a sample replaces its earlier demo copy, so the demo never duplicates.
  if (id) await removeDemoCopies(id);
  const call_id = `sim-${id || 'custom'}-${Date.now()}`;
  try {
    const lead = await processPostCall({
      call_id, transcript: text, simulated: true, precomputed,
      phone: phone || `+91 90000 ${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
      entities: email ? { caller_email: email } : {},
      call_date: endedAt, ended_at: endedAt, duration_s: sampleDuration(text.split('\n')[0]),
    });
    res.json({ lead_id: lead.id, route: lead.decision?.route, duplicate: lead.duplicate || false });
  } catch (err) {
    await logEvent({ type: 'simulate', status: 'failed', error: err.message, simulated: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-simulated', async (req, res) => {
  const db = store();
  let n = 0;
  for (const col of ['leads', 'calls', 'events']) {
    for (const r of await db.all(col)) if (r.simulated) { await db.remove(col, r.id); n++; }
  }
  res.json({ removed: n });
});

app.use(express.static(path.join(__dirname, 'web')));

// "T01 · Phone · 2 September · 10:23am · 4 min 12 sec" → the original call time (IST).
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function sampleTime(header) {
  const m = header.match(/(\d{1,2}) (\w+) · (\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') h += 12;
  return new Date(Date.UTC(2026, MONTHS.indexOf(m[2].toLowerCase()), Number(m[1]), h, Number(m[4])) - 5.5 * 36e5).toISOString();
}
function sampleDuration(header) {
  const m = header.match(/(\d+) min (\d+) sec/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

async function removeDemoCopies(sampleId) {
  const db = store();
  const prefix = `sim-${sampleId}-`;
  const leads = (await db.all('leads')).filter(l => l.simulated && (l.call_ids || []).some(c => c.startsWith(prefix)));
  const ids = new Set(leads.map(l => l.id));
  for (const l of leads) await db.remove('leads', l.id);
  for (const c of await db.all('calls')) if (c.simulated && String(c.id).startsWith(prefix)) await db.remove('calls', c.id);
  for (const e of await db.all('events')) if (e.lead_id && ids.has(e.lead_id)) await db.remove('events', e.id);
  for (const e of await db.all('events')) if (String(e.id).startsWith(`postcall:${prefix}`)) await db.remove('events', e.id);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = app;
