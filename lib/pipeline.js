// End-of-call pipeline. One Vaani call in, one lead record out, plus every
// downstream action, each run at most once per idempotency key:
//
//   transcript → Gemini extraction → grounding check → rules engine
//              → fact-check of what the agent said
//              → merge with a dropped call / mark repeat caller
//              → actions for the route (HubSpot, Calendly link, emails, Telegram)
//
// The lead is saved before any action runs, so a failed integration leaves a
// visible 'failed' event and a Retry button, never a lost enquiry.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { store } = require('./store');
const extract = require('./extract');
const { verifyExtraction } = require('./verify-extraction');
const { qualify } = require('./qualify');
const { factCheck } = require('./factcheck');
const { pricingViolations } = require('./guardrail');
const { loadPolicy } = require('./policy');
const { parseTranscript, transcriptForExtraction, fetchCallInfo } = require('./vaani');
const { designerHandoff, callerBookingLink } = require('./templates');
const hubspot = require('./integrations/hubspot');
const calendly = require('./integrations/calendly');
const email = require('./integrations/email');
const telegram = require('./integrations/telegram');

const now = () => new Date().toISOString();
const newId = prefix => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const baseUrl = () => (process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/$/, '');

// ---------------------------------------------------------------- events

async function logEvent(e) {
  const ev = { id: e.id || newId('ev'), at: now(), ...e };
  await store().put('events', ev.id, ev);
  return ev;
}

// Runs fn once per key. 'ok' results are never repeated (webhook replays,
// retries); 'failed' and 'skipped' ones run again on retry.
async function once(key, { lead, type, isConfigured = true }, fn) {
  const prev = await store().get('events', key);
  if (prev?.status === 'ok') return { status: 'ok', result: prev.result, replayed: true };
  const base = { id: key, type, lead_id: lead.id, simulated: !!lead.simulated, attempts: (prev?.attempts || 0) + 1 };
  if (!isConfigured) {
    await logEvent({ ...base, status: 'skipped', detail: 'Integration not configured' });
    return { status: 'skipped' };
  }
  try {
    const result = await fn();
    await logEvent({ ...base, status: 'ok', result });
    return { status: 'ok', result };
  } catch (err) {
    await logEvent({ ...base, status: 'failed', error: err.message });
    return { status: 'failed', error: err.message };
  }
}

// The Vaani agent this studio owns (config/vaani-agent.json, written by vaani:sync).
function aanganAgentId() {
  if (process.env.VAANI_AGENT_ID) return process.env.VAANI_AGENT_ID;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'vaani-agent.json'), 'utf-8')).agent_id; } catch { return null; }
}

// ---------------------------------------------------------------- designers

function pickDesigner(lead, leads) {
  const team = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'team.json'), 'utf-8')).designers || [];
  if (!team.length) return { name: 'Design team', email: process.env.DESIGNER_EMAIL || null };
  const flags = lead.decision.flags;
  const principal = team.find(d => d.principal);
  if (principal && (flags.includes('large_project') || flags.includes('vip_referral'))) return principal;
  const load = d => leads.filter(l => l.assigned_to?.email === d.email).length;
  return team.filter(d => !d.principal || team.length === 1).sort((a, b) => load(a) - load(b))[0] || team[0];
}

// ---------------------------------------------------------------- main entry

async function processPostCall(call) {
  const policy = loadPolicy();
  const db = store();

  // A replayed webhook for the same call does nothing.
  const claimed = await db.insertIfAbsent('events', `postcall:${call.call_id}`, { id: `postcall:${call.call_id}`, at: now(), type: 'postcall_claim', call_id: call.call_id });
  if (!claimed) return { duplicate: true, call_id: call.call_id };

  const existingCall = (await db.get('calls', call.call_id)) || {};
  let info = null;
  if (!call.simulated) info = await fetchCallInfo(call.call_id).catch(err => ({ error: err.message }));
  // Vaani's webhook is account-wide: only handle calls to the Aangan agent.
  const ourAgent = aanganAgentId();
  if (info?.agent_id && ourAgent && info.agent_id !== ourAgent) {
    await logEvent({ type: 'ignored_other_agent', status: 'skipped', call_id: call.call_id, detail: `Call to another Vaani agent (${info.agent_id})` });
    return { ignored: true, call_id: call.call_id };
  }
  const phone = call.phone || existingCall.phone || info?.phone || null;
  const callRec = {
    ...existingCall,
    id: call.call_id,
    phone,
    ended_at: call.ended_at || now(),
    duration_s: call.duration_s ?? existingCall.duration_s ?? null,
    transcript: call.transcript,
    recording_url: call.recording_url || null,
    vaani_summary: call.summary || null,
    vaani_entities: call.entities || {},
    cost_credits: info?.cost_credits ?? null,
    simulated: !!call.simulated,
  };
  await db.put('calls', callRec.id, callRec);

  // Dropped call → merge into the lead from a few minutes ago.
  const leads = await db.all('leads');
  const samePhone = phone ? leads.filter(l => l.phone === phone).sort((a, b) => b.last_call_at.localeCompare(a.last_call_at)) : [];
  const windowMs = policy.sla.dropped_call_merge_minutes * 60 * 1000;
  const recent = samePhone.find(l => new Date(callRec.ended_at) - new Date(l.last_call_at) < windowMs);
  const prior = recent ? null : samePhone[0] || null;

  const transcript = recent ? `${recent.transcript}\n--- call dropped; caller rang back ---\n${call.transcript}` : call.transcript;
  const turns = parseTranscript(transcript);
  const extractionText = transcriptForExtraction(turns);

  const started = Date.now();
  // Replays may reuse the eval's cached extraction of the same transcript (no new Gemini call).
  const { extraction: raw, usage } = call.simulated && call.precomputed && !recent
    ? structuredClone(call.precomputed)
    : await extract.extractCall({ transcript: extractionText, callDate: (call.call_date || callRec.ended_at).slice(0, 10) });
  const { extraction, warnings } = verifyExtraction(raw, extractionText);
  if (recent) extraction.dropped_call = true;
  if (prior && !extraction.repeat.claims_prior_contact && extraction.call_type === 'new_enquiry') {
    extraction.repeat = { claims_prior_contact: false, detail: `Called before on ${prior.last_call_at.slice(0, 10)} (${prior.decision.route}).` };
  }
  const decision = qualify(extraction, policy);
  if (prior && extraction.call_type === 'new_enquiry') {
    decision.flags.push('known_caller');
    if (prior.decision.route === 'qualified' && prior.booking?.status !== 'booked') {
      decision.priority = 'high';
      decision.confirm_at_consultation.unshift(`They enquired on ${prior.last_call_at.slice(0, 10)} and never got booked. Open with an apology.`);
    }
  }
  const check = factCheck(turns.filter(t => t.speaker !== 'meta'), []);

  const vaaniEmail = call.entities?.caller_email;
  const lead = {
    ...(recent || {}),
    id: recent?.id || newId('lead'),
    created_at: recent?.created_at || now(),
    updated_at: now(),
    phone,
    name: extraction.caller_name || recent?.name || null,
    email: extraction.requests?.email || (vaaniEmail && /@/.test(vaaniEmail) ? vaaniEmail.trim() : null) || recent?.email || null,
    call_ids: [...(recent?.call_ids || []), call.call_id],
    last_call_at: callRec.ended_at,
    simulated: !!call.simulated,
    prior_lead_id: prior?.id || recent?.prior_lead_id || null,
    transcript,
    extraction,
    grounding_warnings: warnings,
    decision,
    factcheck: check,
    recording_url: call.recording_url || recent?.recording_url || null,
    booking: recent?.booking || { status: 'none' },
    handoff: recent?.handoff || { status: 'none' },
    hubspot: recent?.hubspot || {},
    timing: {
      call_ended_at: recent?.timing?.call_ended_at || callRec.ended_at,
      processed_at: now(),
      processing_ms: Date.now() - started,
    },
    costs: {
      vaani_credits: (recent?.costs?.vaani_credits || 0) + (callRec.cost_credits || 0),
      gemini_input_tokens: (recent?.costs?.gemini_input_tokens || 0) + usage.input_tokens,
      gemini_output_tokens: (recent?.costs?.gemini_output_tokens || 0) + usage.output_tokens,
      duration_s: (recent?.costs?.duration_s || 0) + (callRec.duration_s || 0),
    },
  };
  await db.put('leads', lead.id, lead);
  await db.put('calls', callRec.id, { ...callRec, lead_id: lead.id });
  await logEvent({ type: 'decision', status: 'ok', lead_id: lead.id, call_id: call.call_id, simulated: lead.simulated, result: { route: decision.route, reason_codes: decision.reason_codes, policy_version: decision.policy_version, grounding_warnings: warnings.length, factcheck_violations: check.violations.length } });

  return runActions(lead.id);
}

// ---------------------------------------------------------------- actions

const PLAN = {
  qualified: ['hubspot', 'booking_link', 'caller_email', 'designer_email'],
  review: ['hubspot', 'telegram_review'],
  escalate: ['telegram_escalate', 'hubspot'],
  nurture: ['hubspot'],
  declined: ['hubspot'],
  no_conversation: ['telegram_callback'],
};

async function runActions(leadId) {
  const db = store();
  const lead = await db.get('leads', leadId);
  const route = lead.decision.route;
  const steps = [...(PLAN[route] || [])];
  if (!lead.factcheck.ok) steps.push('telegram_factcheck');
  const results = {};
  for (const step of steps) results[step] = await ACTIONS[step](lead);
  lead.action_status = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status]));
  lead.updated_at = now();
  await db.put('leads', lead.id, lead);
  return lead;
}

const x = lead => lead.extraction;
const shortWhere = lead => [x(lead).project?.property_type, x(lead).project?.locality].filter(Boolean).join(', ') || 'project';

const ACTIONS = {
  async hubspot(lead) {
    const d = lead.decision;
    return once(`${lead.id}:hubspot:${lead.call_ids.length}`, { lead, type: 'hubspot', isConfigured: hubspot.configured() }, async () => {
      const contact = await hubspot.upsertContact({ phone: lead.phone, name: lead.name, email: lead.email, locality: x(lead).project?.locality });
      lead.hubspot.contact_id = contact.id;
      if (d.route === 'qualified' && !lead.hubspot.deal_id) {
        lead.hubspot.deal_id = (await hubspot.createDeal({ contactId: contact.id, name: `${lead.name || 'Caller'} · ${shortWhere(lead)}` })).id;
      }
      const note = [
        `<b>AI front desk · ${d.route.toUpperCase()}</b> (policy ${d.policy_version})`,
        x(lead).summary,
        d.reason_codes.length ? `Reasons: ${d.reason_codes.join(', ')}` : null,
        d.flags.length ? `Flags: ${d.flags.join(', ')}` : null,
        ...Object.values(d.criteria).map(c => `${c.status.toUpperCase()} — ${c.name}: ${c.reason}`),
      ].filter(Boolean).join('<br>');
      await hubspot.addNote({ contactId: contact.id, dealId: lead.hubspot.deal_id, body: note });
      if (d.route === 'nurture') {
        const due = new Date(Date.now() + 21 * 864e5).toISOString();
        await hubspot.addTask({ contactId: contact.id, subject: `Follow up: ${lead.name || 'caller'} (${shortWhere(lead)})`, body: `Timeline too short at first call (${x(lead).timeline?.needed_by_text || ''}). Ask if a later start works.`, dueAt: due });
      }
      return { contact_id: contact.id, deal_id: lead.hubspot.deal_id || null };
    });
  },

  async booking_link(lead) {
    if (!lead.email) {
      lead.booking = { status: 'no_email' };
      return { status: 'skipped', detail: 'No email captured; designer will call to fix a time.' };
    }
    const r = await once(`${lead.id}:booking_link`, { lead, type: 'calendly', isConfigured: calendly.configured() }, () =>
      calendly.createBookingLink({ siteVisit: x(lead).requests?.site_visit, name: lead.name, email: lead.email }));
    if (r.status === 'ok') lead.booking = { ...lead.booking, status: lead.booking.status === 'booked' ? 'booked' : 'link_created', url: r.result.url };
    return r;
  },

  async caller_email(lead) {
    if (!lead.email || !lead.booking?.url) return { status: 'skipped' };
    const msg = callerBookingLink({ name: lead.name, bookingUrl: lead.booking.url, siteVisit: x(lead).requests?.site_visit });
    const key = `${lead.id}:caller_email`;
    const r = await once(key, { lead, type: 'email_caller', isConfigured: email.configured() }, () => {
      if (pricingViolations(msg.text).length) throw new Error('Caller email failed the pricing guardrail; not sent.');
      return email.sendEmail({ to: lead.email, ...msg, idempotencyKey: key });
    });
    if (r.status === 'ok' && lead.booking.status !== 'booked') lead.booking = { ...lead.booking, status: 'link_sent', sent_at: lead.booking.sent_at || now() };
    return r;
  },

  async designer_email(lead) {
    const leads = await store().all('leads');
    lead.assigned_to = lead.assigned_to || pickDesigner(lead, leads);
    if (!lead.assigned_to.email) return once(`${lead.id}:designer_email`, { lead, type: 'email_designer', isConfigured: false }, () => null);
    // A new token per send; only its hash is stored.
    const token = crypto.randomBytes(24).toString('hex');
    const acceptUrl = `${baseUrl()}/api/accept/${lead.id}/${token}`;
    const key = `${lead.id}:designer_email`;
    const r = await once(key, { lead, type: 'email_designer', isConfigured: email.configured() }, () =>
      email.sendEmail({ to: lead.assigned_to.email, ...designerHandoff({ lead, acceptUrl, dashboardUrl: `${baseUrl()}/#lead=${lead.id}` }), idempotencyKey: key }));
    if (r.status === 'ok' && !r.replayed) {
      lead.handoff = { status: 'sent', sent_at: now(), token_hash: sha(token), expires_at: new Date(Date.now() + 14 * 864e5).toISOString() };
    }
    return r;
  },

  async telegram_escalate(lead) {
    const e = telegram.esc;
    return once(`${lead.id}:telegram_escalate:${lead.call_ids.length}`, { lead, type: 'telegram', isConfigured: telegram.configured() }, () => telegram.alert(
      `🚨 <b>Existing client needs a senior callback within ${loadPolicy().sla.complaint_callback_minutes} min</b>\n` +
      `${e(lead.name || 'Caller')} · ${e(lead.phone || 'number unknown')}\n${e(x(lead).complaint?.detail || x(lead).summary)}` +
      `${x(lead).complaint?.designer_named ? `\nDesigner: ${e(x(lead).complaint.designer_named)}` : ''}` +
      `${x(lead).complaint?.requested_senior ? '\nAsked for Nikhil / someone senior.' : ''}`));
  },

  async telegram_review(lead) {
    const e = telegram.esc;
    return once(`${lead.id}:telegram_review:${lead.call_ids.length}`, { lead, type: 'telegram', isConfigured: telegram.configured() }, () => telegram.alert(
      `🟡 <b>Enquiry needs a quick human look</b>\n${e(lead.name || 'Caller')} · ${e(lead.phone || '')}\n${e(x(lead).summary)}\nWhy: ${e(lead.decision.review_reasons.join(' '))}`));
  },

  async telegram_callback(lead) {
    return once(`${lead.id}:telegram_callback:${lead.call_ids.length}`, { lead, type: 'telegram', isConfigured: telegram.configured() }, () => telegram.alert(
      `📞 <b>Call with no conversation</b> from ${telegram.esc(lead.phone || 'unknown number')}. Worth a callback.`));
  },

  async telegram_factcheck(lead) {
    const v = lead.factcheck.violations;
    return once(`${lead.id}:telegram_factcheck:${lead.call_ids.length}`, { lead, type: 'telegram', isConfigured: telegram.configured() }, () => telegram.alert(
      `⚠️ <b>The AI agent said something it shouldn't have</b> (${telegram.esc(lead.name || lead.phone || lead.id)})\n` +
      v.slice(0, 3).map(i => `• ${telegram.esc(i.type)}: “${telegram.esc(i.text.slice(0, 160))}”`).join('\n')));
  },
};

// ---------------------------------------------------------------- follow-ups

async function acceptHandoff(leadId, token) {
  const db = store();
  const lead = await db.get('leads', leadId);
  if (!lead || !lead.handoff?.token_hash) return { ok: false, reason: 'Unknown lead.' };
  if (lead.handoff.status === 'accepted') return { ok: true, lead, already: true };
  const a = Buffer.from(sha(token)); const b = Buffer.from(lead.handoff.token_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'This link is not valid.' };
  if (new Date(lead.handoff.expires_at) < new Date()) return { ok: false, reason: 'This link has expired.' };
  lead.handoff = { ...lead.handoff, status: 'accepted', accepted_at: now() };
  lead.updated_at = now();
  await db.put('leads', lead.id, lead);
  await logEvent({ type: 'handoff_accepted', status: 'ok', lead_id: lead.id, simulated: !!lead.simulated });
  return { ok: true, lead };
}

// Run on a schedule: nudge Nikhil about unaccepted handoffs, and check
// Calendly for leads that have picked a time.
async function sweep() {
  const policy = loadPolicy();
  const db = store();
  const out = { nudged: 0, booked: 0 };
  for (const lead of await db.all('leads')) {
    if (lead.handoff?.status === 'sent' && Date.now() - new Date(lead.handoff.sent_at) > policy.sla.designer_accept_hours * 36e5) {
      const r = await once(`${lead.id}:sla_nudge`, { lead, type: 'telegram', isConfigured: telegram.configured() }, () => telegram.alert(
        `⏰ <b>Handoff not picked up in ${policy.sla.designer_accept_hours}h</b>: ${telegram.esc(lead.name || lead.phone)} (${telegram.esc(shortWhere(lead))}), sent to ${telegram.esc(lead.assigned_to?.name || 'designer')}. Please reassign.`));
      if (r.status === 'ok' && !r.replayed) out.nudged++;
    }
    if (['link_sent', 'link_created'].includes(lead.booking?.status) && lead.email && calendly.configured()) {
      const ev = await calendly.findBooking(lead.email).catch(() => null);
      if (ev) {
        lead.booking = { ...lead.booking, status: 'booked', booked_at: now(), start_time: ev.start_time };
        await db.put('leads', lead.id, lead);
        await logEvent({ type: 'booked', status: 'ok', lead_id: lead.id, result: ev });
        if (lead.hubspot?.deal_id && hubspot.configured()) await hubspot.updateDealStage(lead.hubspot.deal_id, 'booked').catch(() => {});
        out.booked++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- human decisions

// Review queue: Nikhil (or the front desk) sends a lead on or closes it.
async function decideReview(leadId, choice) {
  const db = store();
  const lead = await db.get('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  if (lead.decision.route !== 'review') throw new Error('Only leads in review can be decided here.');
  const route = choice === 'approve' ? 'qualified' : 'declined';
  lead.decision = {
    ...lead.decision,
    route,
    next_action: route === 'qualified' ? 'book_consultation' : 'log_decline',
    reason_codes: [...lead.decision.reason_codes, choice === 'approve' ? 'MANUAL_APPROVE' : 'MANUAL_DECLINE'],
    overridden: { from: 'review', choice, at: now() },
  };
  lead.updated_at = now();
  await db.put('leads', lead.id, lead);
  await logEvent({ type: 'review_decision', status: 'ok', lead_id: lead.id, simulated: !!lead.simulated, result: { choice, route } });
  return runActions(lead.id);
}

async function markHandled(leadId) {
  const db = store();
  const lead = await db.get('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  lead.handled_at = now();
  await db.put('leads', lead.id, lead);
  await logEvent({ type: 'marked_handled', status: 'ok', lead_id: lead.id, simulated: !!lead.simulated });
  return lead;
}

// A designer picks a lead up from the board (the dashboard is password-protected,
// so no email token is needed here).
async function claimLead(leadId, designer) {
  const db = store();
  const lead = await db.get('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  if (lead.decision.route !== 'qualified') throw new Error('Only qualified enquiries can be picked up.');
  const name = String(designer || '').trim().slice(0, 60) || 'A designer';
  lead.assigned_to = { ...(lead.assigned_to || {}), name };
  lead.handoff = { ...lead.handoff, status: 'accepted', accepted_at: now(), accepted_via: 'board' };
  lead.updated_at = now();
  await db.put('leads', lead.id, lead);
  await logEvent({ type: 'handoff_accepted', status: 'ok', lead_id: lead.id, simulated: !!lead.simulated, detail: `Picked up by ${name} on the board` });
  return lead;
}

// A designer logs how their call went. Picking up an unclaimed lead happens
// on the first outcome, so "I called them" and "it's mine" are one step.
const OUTCOMES = {
  booked: 'Consultation booked',
  no_answer: 'No answer',
  callback: 'Asked to call back',
  not_interested: 'Not interested',
  not_fit: 'Not a fit after all',
  note: 'Note',
};

async function recordOutcome(leadId, { designer, outcome, when, note } = {}) {
  if (!OUTCOMES[outcome]) throw new Error(`outcome must be one of ${Object.keys(OUTCOMES).join(', ')}`);
  const db = store();
  const lead = await db.get('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  if (lead.decision.route !== 'qualified') throw new Error('Outcomes are for qualified enquiries.');
  const name = String(designer || '').trim().slice(0, 60) || 'A designer';
  const text = String(note || '').trim().slice(0, 1000);
  const at = when ? new Date(when) : null;
  if ((outcome === 'booked' || outcome === 'callback') && (!at || Number.isNaN(at.getTime()))) throw new Error('Pick a date and time.');

  if (outcome !== 'note' && (!lead.assigned_to?.name || lead.assigned_to.name === 'Design team')) {
    lead.assigned_to = { ...(lead.assigned_to || {}), name };
  }
  if (outcome !== 'note' && lead.handoff?.status !== 'accepted') {
    lead.handoff = { ...lead.handoff, status: 'accepted', accepted_at: now(), accepted_via: 'outcome' };
  }
  const work = lead.work || { attempts: 0, status: 'open' };
  if (outcome === 'no_answer') { work.attempts = (work.attempts || 0) + 1; work.last_attempt_at = now(); }
  if (outcome === 'callback') { work.callback_at = at.toISOString(); work.status = 'callback'; }
  if (outcome === 'booked') {
    work.status = 'booked';
    lead.booking = { ...lead.booking, status: 'booked', start_time: at.toISOString(), booked_at: now(), booked_via: 'designer' };
  }
  if (outcome === 'not_interested' || outcome === 'not_fit') { work.status = 'closed'; work.closed_reason = outcome; work.closed_at = now(); }
  if (outcome === 'no_answer' && work.status !== 'booked') work.status = 'open';
  lead.work = work;
  lead.notes = [...(lead.notes || []), { at: now(), by: name, outcome, text: text || null, when: at ? at.toISOString() : null }];
  lead.updated_at = now();
  await db.put('leads', lead.id, lead);
  await logEvent({ type: 'designer_outcome', status: 'ok', lead_id: lead.id, simulated: !!lead.simulated, detail: `${OUTCOMES[outcome]} — ${name}${text ? `: ${text}` : ''}` });

  // Mirror to the CRM so sales history stays in one place.
  if (outcome !== 'note' || text) {
    await once(`${lead.id}:outcome:${lead.notes.length}`, { lead, type: 'hubspot', isConfigured: hubspot.configured() && !!lead.hubspot?.contact_id }, async () => {
      await hubspot.addNote({ contactId: lead.hubspot.contact_id, dealId: lead.hubspot.deal_id, body: `<b>${OUTCOMES[outcome]}</b> (${name})${at ? ` — ${at.toISOString()}` : ''}${text ? `<br>${text}` : ''}` });
      if (outcome === 'booked' && lead.hubspot.deal_id) await hubspot.updateDealStage(lead.hubspot.deal_id, 'booked');
      return { ok: true };
    });
  }
  return lead;
}

module.exports = { processPostCall, runActions, acceptHandoff, sweep, logEvent, decideReview, markHandled, claimLead, recordOutcome, OUTCOMES };
