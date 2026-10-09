// End-to-end pipeline tests with every external service faked: Gemini is
// stubbed, and HubSpot / Calendly / Resend / Telegram go through a fake fetch
// that records calls and can be told to fail. Proves idempotency, honest
// failure states, retry, dropped-call merging and the escalation path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useMemoryStore, store } = require('../lib/store');
const extract = require('../lib/extract');
const { processPostCall, runActions, acceptHandoff, sweep, decideReview, markHandled, recordOutcome } = require('../lib/pipeline');
const { computeMetrics } = require('../lib/metrics');
const crypto = require('crypto');

Object.assign(process.env, {
  HUBSPOT_ACCESS_TOKEN: 'test', CALENDLY_TOKEN: 'test', CALENDLY_EVENT_TYPE_URI: 'https://api.calendly.com/event_types/X',
  RESEND_API_KEY: 'test', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '1', DESIGNER_EMAIL: 'designers@studio.test',
});
delete process.env.EMAIL_OVERRIDE_TO;
delete process.env.VAANI_API_KEY;

// ---- fake services
let calls = [];
let failing = new Set();
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const host = u.includes('hubapi') ? 'hubspot' : u.includes('calendly') ? 'calendly' : u.includes('resend') ? 'resend' : u.includes('telegram') ? 'telegram' : 'other';
  calls.push({ host, url: u, body: opts.body ? JSON.parse(opts.body) : null });
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (failing.has(host)) return reply(500, { message: `${host} is down` });
  if (host === 'hubspot') {
    if (u.endsWith('/contacts/search')) return reply(200, { results: [] });
    return reply(201, { id: String(calls.length) });
  }
  if (host === 'calendly') return reply(201, { resource: { booking_url: 'https://calendly.com/d/abc-123' } });
  if (host === 'resend') return reply(200, { id: `email_${calls.length}` });
  if (host === 'telegram') return reply(200, { ok: true, result: { message_id: 1 } });
  return reply(404, {});
};
const count = host => calls.filter(c => c.host === host).length;

// ---- stubbed Gemini
function facts(over = {}) {
  const base = {
    call_type: 'new_enquiry', caller_name: 'Priya Kulkarni', language: 'English', summary: '3BHK in Kothrud, full redesign by March.',
    referral: { how_found: 'friend', referrer_name: null, knows_founder: false },
    project: { segment: 'residential', property_type: '3BHK flat', locality: 'Kothrud', city: 'Pune', carpet_area_sqft: 1400, scope_type: 'full_home', rooms: ['kitchen'], room_count: 4, current_state: 'builder flat', occupancy: 'owner', structural_changes: false },
    engagement: { wants_design_and_execution: 'yes', signal: null },
    timeline: { needed_by_text: 'by March', weeks_until_needed: 26, site_available_text: null, weeks_until_site_available: 0, preferred_start_text: null, flexible: true },
    budget: { volunteered: false, max_inr: null, text: null },
    decision_maker: { status: 'self', detail: null },
    pricing: { asked: true, times_pushed: 1 },
    complaint: { is_existing_client: false, detail: null, designer_named: null, requested_senior: false },
    repeat: { claims_prior_contact: false, detail: null },
    dropped_call: false,
    requests: { site_visit: false, consultation_wanted: true, preferred_slots: 'Saturday mornings', email: 'priya@example.com' },
    evidence: [], open_questions: [],
  };
  return { ...base, ...over };
}
let nextFacts = facts();
extract.extractCall = async () => ({ extraction: structuredClone(nextFacts), usage: { model: 'stub', input_tokens: 1000, output_tokens: 200 } });

const TRANSCRIPT = `[10:00:01] AGENT: Hello, thank you for calling Aangan Studio.
[10:00:05] USER: Hi, I'm Priya Kulkarni. 3BHK in Kothrud, about 1400 sq ft, full redesign by March. How much will it cost?
[10:00:12] AGENT: Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation.
[10:00:30] USER: My email is priya@example.com. Saturday mornings work.
[10:00:40] AGENT: Right after this call you'll get an email from Aangan Studio with a link to pick your consultation time.`;

const call = (id, over = {}) => ({ call_id: id, transcript: TRANSCRIPT, phone: '+919800000001', ended_at: new Date().toISOString(), duration_s: 60, simulated: true, ...over });

test.beforeEach(() => { useMemoryStore(); calls = []; failing = new Set(); nextFacts = facts(); });

test('qualified call: CRM, booking link, caller email, designer handoff', async () => {
  const lead = await processPostCall(call('c1'));
  assert.equal(lead.decision.route, 'qualified');
  assert.deepEqual(lead.action_status, { hubspot: 'ok', booking_link: 'ok', caller_email: 'ok', designer_email: 'ok' });
  assert.equal(lead.booking.status, 'link_sent');
  assert.equal(lead.handoff.status, 'sent');
  const emails = calls.filter(c => c.host === 'resend').map(c => c.body);
  assert.equal(emails.length, 2);
  assert.ok(emails[0].text.includes('https://calendly.com/d/abc-123'), 'caller gets the link');
  assert.ok(emails[1].text.includes("DON'T RE-ASK"), 'designer gets the brief');
  assert.ok(emails[1].text.includes('Asked about price (deflected, not quoted)'));
  assert.equal(lead.factcheck.ok, true);
});

test('replayed webhook does nothing the second time', async () => {
  await processPostCall(call('c1'));
  const before = calls.length;
  const again = await processPostCall(call('c1'));
  assert.equal(again.duplicate, true);
  assert.equal(calls.length, before);
  assert.equal((await store().all('leads')).length, 1);
});

test('HubSpot outage: lead is saved, failure is visible, retry completes without duplicate emails', async () => {
  failing.add('hubspot');
  const lead = await processPostCall(call('c1'));
  assert.equal(lead.action_status.hubspot, 'failed');
  assert.equal(lead.action_status.designer_email, 'ok', 'the designer still gets the lead');
  const failed = (await store().all('events')).filter(e => e.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /hubspot is down/);

  failing.clear();
  const emailsBefore = count('resend');
  const after = await runActions(lead.id);
  assert.equal(after.action_status.hubspot, 'ok');
  assert.equal(count('resend'), emailsBefore, 'retry does not re-send emails');
});

test('Calendly down: never claims a booking, designer is told', async () => {
  failing.add('calendly');
  const lead = await processPostCall(call('c1'));
  assert.equal(lead.action_status.booking_link, 'failed');
  assert.equal(lead.action_status.caller_email, 'skipped');
  assert.notEqual(lead.booking.status, 'booked');
  const designer = calls.filter(c => c.host === 'resend').map(c => c.body).at(-1);
  assert.match(designer.text, /Booking link not sent yet/);
});

test('no email captured: designer is asked to call to fix a time', async () => {
  nextFacts = facts({ requests: { ...facts().requests, email: null } });
  const lead = await processPostCall(call('c1'));
  assert.equal(lead.booking.status, 'no_email');
  assert.match(calls.filter(c => c.host === 'resend')[0].body.text, /please call them to fix a time/);
});

test('existing-client complaint: Telegram alert, no designer email, no deal', async () => {
  nextFacts = facts({ call_type: 'existing_client_issue', complaint: { is_existing_client: true, detail: 'Designer silent for five days', designer_named: 'Aryan', requested_senior: true } });
  const lead = await processPostCall(call('c9'));
  assert.equal(lead.decision.route, 'escalate');
  assert.equal(count('telegram'), 1);
  assert.match(calls.find(c => c.host === 'telegram').body.text, /senior callback/);
  assert.equal(count('resend'), 0);
  assert.equal(calls.filter(c => c.url.includes('/deals')).length, 0);
});

test('dropped call and quick callback become one lead', async () => {
  nextFacts = facts({ call_type: 'no_conversation' });
  const first = await processPostCall(call('d1', { transcript: '[10:00:01] AGENT: Hello, Aangan Studio.\n[10:00:03] USER: Hi, I wanted to ask about —' }));
  assert.equal(first.decision.route, 'no_conversation');
  nextFacts = facts();
  const second = await processPostCall(call('d2', { ended_at: new Date(Date.now() + 120e3).toISOString() }));
  assert.equal(second.id, first.id);
  assert.deepEqual(second.call_ids, ['d1', 'd2']);
  assert.ok(second.decision.flags.includes('dropped_call'));
  assert.equal((await store().all('leads')).length, 1);
});

test('caller who enquired before and was never booked comes back as high priority', async () => {
  const first = await processPostCall(call('r1', { ended_at: new Date(Date.now() - 3 * 864e5).toISOString() }));
  const lead = first; lead.booking = { status: 'link_sent' }; await store().put('leads', lead.id, lead);
  const second = await processPostCall(call('r2'));
  assert.notEqual(second.id, first.id);
  assert.equal(second.prior_lead_id, first.id);
  assert.equal(second.decision.priority, 'high');
  assert.ok(second.decision.flags.includes('known_caller'));
});

test('agent that quotes a price is caught and Nikhil is alerted', async () => {
  const lead = await processPostCall(call('p1', { transcript: TRANSCRIPT + '\n[10:01:00] AGENT: Roughly it would be around 12 lakh.' }));
  assert.equal(lead.factcheck.ok, false);
  assert.equal(lead.action_status.telegram_factcheck, 'ok');
  assert.match(calls.find(c => c.host === 'telegram').body.text, /said something it shouldn't/);
});

test('accept link works once, with the right token only', async () => {
  const lead = await processPostCall(call('c1'));
  const designerEmail = calls.filter(c => c.host === 'resend').at(-1).body.text;
  const url = designerEmail.match(/\/api\/accept\/(\S+)\/(\w+)/);
  assert.ok(url, 'accept link in email');
  assert.equal((await acceptHandoff(lead.id, 'wrong')).ok, false);
  const r = await acceptHandoff(url[1], url[2]);
  assert.equal(r.ok, true);
  assert.equal(r.lead.handoff.status, 'accepted');
  const stored = await store().get('leads', lead.id);
  assert.equal(stored.handoff.token_hash, crypto.createHash('sha256').update(url[2]).digest('hex'), 'only the hash is stored');
});

test('unaccepted handoff nudges Nikhil once', async () => {
  const lead = await processPostCall(call('c1'));
  lead.handoff.sent_at = new Date(Date.now() - 5 * 36e5).toISOString();
  await store().put('leads', lead.id, lead);
  failing.add('calendly'); // skip booking lookup noise
  assert.equal((await sweep()).nudged, 1);
  assert.equal((await sweep()).nudged, 0);
});

test('review lead: approving sends it to a designer, with an audit trail', async () => {
  nextFacts = facts({ project: { ...facts().project, locality: null, city: null } });
  const lead = await processPostCall(call('v1'));
  assert.equal(lead.decision.route, 'review');
  assert.equal(count('resend'), 0);
  const after = await decideReview(lead.id, 'approve');
  assert.equal(after.decision.route, 'qualified');
  assert.ok(after.decision.reason_codes.includes('MANUAL_APPROVE'));
  assert.equal(after.action_status.designer_email, 'ok');
  assert.ok((await store().all('events')).some(e => e.type === 'review_decision' && e.result.choice === 'approve'));
  await assert.rejects(decideReview(lead.id, 'decline'), /Only leads in review/);
});

test('attention list: urgent first, and handled items drop off', async () => {
  nextFacts = facts({ call_type: 'existing_client_issue', complaint: { is_existing_client: true, detail: 'x', designer_named: null, requested_senior: true } });
  const complaint = await processPostCall(call('a1'));
  nextFacts = facts({ project: { ...facts().project, locality: null, city: null } });
  await processPostCall(call('a2', { phone: '+919800000002' }));
  const metrics = async () => computeMetrics({ leads: await store().all('leads'), calls: await store().all('calls'), events: await store().all('events'), includeSimulated: true });
  let att = (await metrics()).attention;
  assert.deepEqual(att.map(a => a.kind), ['complaint', 'review']);
  await markHandled(complaint.id);
  att = (await metrics()).attention;
  assert.deepEqual(att.map(a => a.kind), ['review']);
});

test('period filter counts only enquiries in range', async () => {
  await processPostCall(call('old', { ended_at: new Date(Date.now() - 40 * 864e5).toISOString() }));
  await processPostCall(call('new', { phone: '+919800000003' }));
  const all = await store().all('leads');
  const m30 = computeMetrics({ leads: all, calls: await store().all('calls'), events: [], includeSimulated: true, period: '30d' });
  const mAll = computeMetrics({ leads: all, calls: await store().all('calls'), events: [], includeSimulated: true, period: 'all' });
  assert.equal(m30.funnel[0].value, 1);
  assert.equal(mAll.funnel[0].value, 2);
});

test('designer outcomes: no answer counts attempts, booking claims the lead and books it', async () => {
  const lead = await processPostCall(call('o1'));
  let l = await recordOutcome(lead.id, { designer: 'Ananya', outcome: 'no_answer' });
  l = await recordOutcome(lead.id, { designer: 'Ananya', outcome: 'no_answer', note: 'Rang twice, voicemail full' });
  assert.equal(l.work.attempts, 2);
  assert.equal(l.assigned_to.name, 'Ananya');
  assert.equal(l.handoff.status, 'accepted');
  const when = new Date(Date.now() + 2 * 864e5).toISOString();
  l = await recordOutcome(lead.id, { designer: 'Ananya', outcome: 'booked', when });
  assert.equal(l.booking.status, 'booked');
  assert.equal(l.booking.start_time, when);
  assert.equal(l.notes.length, 3);
  assert.ok((await store().all('events')).some(e => e.type === 'designer_outcome'));
});

test('designer outcomes: booking needs a date, closing records the reason', async () => {
  const lead = await processPostCall(call('o2'));
  await assert.rejects(recordOutcome(lead.id, { designer: 'Rahul', outcome: 'booked' }), /date/);
  const l = await recordOutcome(lead.id, { designer: 'Rahul', outcome: 'not_interested', note: 'Went with a contractor' });
  assert.equal(l.work.status, 'closed');
  assert.equal(l.work.closed_reason, 'not_interested');
  await assert.rejects(recordOutcome(lead.id, { outcome: 'teleport' }), /outcome must be/);
});
