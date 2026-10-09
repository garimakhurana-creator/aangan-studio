// Rules-engine tests. Each case is a hand-built extraction modelled on a real
// transcript, so the rules are verified without calling Gemini.

const test = require('node:test');
const assert = require('node:assert/strict');
const { qualify } = require('../lib/qualify');
const { classifyLocality, costFloor, loadPolicy } = require('../lib/policy');

// A clean qualified enquiry (T01). Tests override only what they're about.
function call(overrides = {}) {
  const base = {
    call_type: 'new_enquiry',
    caller_name: 'Priya',
    language: 'English',
    summary: '',
    referral: { how_found: 'friend', referrer_name: null, knows_founder: false },
    project: {
      segment: 'residential', property_type: '3BHK flat', locality: 'Kothrud', city: 'Pune',
      carpet_area_sqft: 1400, scope_type: 'full_home', rooms: ['kitchen', 'living room', 'bedroom', 'bedroom'],
      room_count: 4, current_state: 'builder flat', occupancy: 'owner', structural_changes: false,
    },
    engagement: { wants_design_and_execution: 'yes', signal: 'redo the whole thing' },
    timeline: { needed_by_text: 'by March', weeks_until_needed: 26, site_available_text: null, weeks_until_site_available: 0, flexible: true },
    budget: { volunteered: false, max_inr: null, text: null },
    decision_maker: { status: 'authorised', detail: 'husband knows and is happy to go ahead' },
    pricing: { asked: false, times_pushed: 0 },
    complaint: { is_existing_client: false, detail: null, designer_named: null, requested_senior: false },
    repeat: { claims_prior_contact: false, detail: null },
    dropped_call: false,
    requests: { site_visit: false, consultation_wanted: true, preferred_slots: null },
    evidence: [],
    open_questions: [],
  };
  const merged = { ...base, ...overrides };
  for (const k of ['referral', 'project', 'engagement', 'timeline', 'budget', 'decision_maker', 'pricing', 'complaint', 'repeat', 'requests']) {
    merged[k] = { ...base[k], ...(overrides[k] || {}) };
  }
  return merged;
}

test('T01 clean enquiry qualifies and books', () => {
  const d = qualify(call());
  assert.equal(d.route, 'qualified');
  assert.equal(d.next_action, 'book_consultation');
  assert.ok(Object.values(d.criteria).every(c => c.status === 'pass'));
  assert.match(d.policy_version, /\d{4}-\d{2}-\d{2}/);
});

test('T02/T13 asking for pricing never disqualifies', () => {
  const d = qualify(call({ pricing: { asked: true, times_pushed: 2 } }));
  assert.equal(d.route, 'qualified');
  assert.ok(d.flags.includes('pricing_asked'));
});

test('T03 Nashik is declined as out of area', () => {
  const d = qualify(call({ project: { locality: null, city: 'Nashik' } }));
  assert.equal(d.route, 'declined');
  assert.deepEqual(d.reason_codes, ['OUT_OF_AREA']);
  assert.match(d.caller_line, /Pune city and PCMC/);
});

test('F03 "Talegaon, near Pune" is out even though Pune is mentioned', () => {
  assert.equal(classifyLocality('Talegaon Dabhade', 'near Pune').status, 'out');
});

test('localities: named, adjoining and unknown', () => {
  assert.equal(classifyLocality('Pimple Saudagar', null).status, 'in');
  assert.equal(classifyLocality('Kharadi', 'Pune').status, 'adjoining');
  assert.equal(classifyLocality('Some New Township', 'Pune').status, 'adjoining');
  assert.equal(classifyLocality(null, null).status, 'unknown');
});

test('T04 advice only is declined', () => {
  const d = qualify(call({ engagement: { wants_design_and_execution: 'no', signal: 'just want suggestions' } }));
  assert.equal(d.route, 'declined');
  assert.deepEqual(d.reason_codes, ['ADVICE_ONLY']);
});

test('T05 friend of Nikhil is a high-priority VIP', () => {
  const d = qualify(call({ referral: { referrer_name: 'Vikram Agarwal', knows_founder: true }, requests: { site_visit: true } }));
  assert.equal(d.route, 'qualified');
  assert.equal(d.priority, 'high');
  assert.ok(d.flags.includes('vip_referral') && d.flags.includes('site_visit_requested'));
});

test('T06 800 sq ft office qualifies', () => {
  const d = qualify(call({ project: { segment: 'commercial', property_type: 'office', locality: 'Baner', carpet_area_sqft: 800, scope_type: 'office_fitout' } }));
  assert.equal(d.route, 'qualified');
});

test('T07 three weeks before Diwali: timeline-only fail is nurtured, not lost', () => {
  const d = qualify(call({ timeline: { needed_by_text: 'before Diwali', weeks_until_needed: 3, flexible: false } }));
  assert.equal(d.route, 'nurture');
  assert.equal(d.next_action, 'create_followup_task');
  assert.deepEqual(d.reason_codes, ['TIMELINE_TOO_SHORT']);
});

test('timeline boundaries: 6 weeks passes as tight, 5 fails, site in 6 months fails', () => {
  assert.equal(qualify(call({ timeline: { weeks_until_needed: 6 } })).route, 'qualified');
  assert.ok(qualify(call({ timeline: { weeks_until_needed: 6 } })).flags.includes('tight_timeline'));
  assert.equal(qualify(call({ timeline: { weeks_until_needed: 5 } })).route, 'nurture');
  const late = qualify(call({ timeline: { weeks_until_needed: null, weeks_until_site_available: 26 } }));
  assert.deepEqual(late.reason_codes, ['SITE_NOT_READY']);
});

test('T15 possession in six weeks is fine', () => {
  const d = qualify(call({ timeline: { weeks_until_needed: null, weeks_until_site_available: 6, flexible: null } }));
  assert.equal(d.route, 'qualified');
});

test('T08 missed call schedules a callback', () => {
  const d = qualify(call({ call_type: 'no_conversation' }));
  assert.equal(d.route, 'no_conversation');
  assert.equal(d.next_action, 'callback');
});

test('T09 existing-client complaint escalates and is never a lead', () => {
  const d = qualify(call({ call_type: 'existing_client_issue', complaint: { is_existing_client: true, requested_senior: true } }));
  assert.equal(d.route, 'escalate');
  assert.equal(d.priority, 'urgent');
  assert.equal(d.next_action, 'alert_nikhil');
  assert.deepEqual(d.criteria, {});
});

test('T10 volunteered 1.5 lakh for kitchen + bedroom is declined on budget', () => {
  const d = qualify(call({
    project: { property_type: '1BHK', locality: 'Kharadi', carpet_area_sqft: 550, scope_type: 'partial', rooms: ['kitchen', 'bedroom'], room_count: 2 },
    budget: { volunteered: true, max_inr: 150000, text: '1 to 1.5 lakh' },
  }));
  assert.equal(d.route, 'declined');
  assert.deepEqual(d.reason_codes, ['BUDGET_MISALIGNED']);
});

test('a plausible volunteered budget passes (F06: 40 lakh for 4BHK partial)', () => {
  const d = qualify(call({ project: { scope_type: 'partial', room_count: 6, carpet_area_sqft: 1950 }, budget: { volunteered: true, max_inr: 4000000 } }));
  assert.equal(d.criteria.c4.status, 'pass');
});

test('budget not mentioned is treated as qualified (no probing)', () => {
  assert.equal(qualify(call()).criteria.c4.not_discussed, true);
});

test('T11 rented flat with no structural work qualifies', () => {
  const d = qualify(call({ project: { occupancy: 'tenant' } }));
  assert.equal(d.route, 'qualified');
  assert.ok(d.flags.includes('rented'));
});

test('T12 villa is flagged large', () => {
  const d = qualify(call({ project: { property_type: 'villa', carpet_area_sqft: 5500, locality: 'Kalyani Nagar' } }));
  assert.ok(d.flags.includes('large_project'));
});

test('T14 son calling for parents who will attend qualifies with a note', () => {
  const d = qualify(call({ decision_maker: { status: 'proxy_decider_will_attend' } }));
  assert.equal(d.route, 'qualified');
  assert.ok(d.flags.includes('proxy_caller'));
});

test('research-only caller is still qualified but asks to confirm the decider', () => {
  const d = qualify(call({ decision_maker: { status: 'research_only' } }));
  assert.equal(d.route, 'qualified');
  assert.ok(d.confirm_at_consultation.some(q => /decision/.test(q)));
});

test('T16 repeat caller gets priority and an apology prompt', () => {
  const d = qualify(call({ repeat: { claims_prior_contact: true } }));
  assert.equal(d.priority, 'high');
  assert.match(d.confirm_at_consultation[0], /apology/);
});

test('T18 180 sq ft pod is far below the commercial minimum', () => {
  const d = qualify(call({ project: { segment: 'commercial', property_type: 'coworking pod', carpet_area_sqft: 180, scope_type: 'office_fitout' } }));
  assert.deepEqual(d.reason_codes, ['BELOW_MIN_SIZE']);
});

test('400 sq ft office rests on the unconfirmed 500 minimum, so it goes to review', () => {
  const d = qualify(call({ project: { segment: 'commercial', carpet_area_sqft: 400, scope_type: 'office_fitout' } }));
  assert.equal(d.route, 'review');
});

test('T19 restaurant and W07 gym are out of segment', () => {
  for (const segment of ['hospitality', 'fitness', 'retail']) {
    assert.deepEqual(qualify(call({ project: { segment } })).reason_codes, ['SEGMENT_OUT_OF_SCOPE']);
  }
});

test('two failures use the general decline line', () => {
  const d = qualify(call({ project: { city: 'Mumbai', locality: null }, timeline: { weeks_until_needed: 3 } }));
  assert.equal(d.route, 'declined');
  assert.equal(d.caller_line, loadPolicy().approved_lines.decline_multi);
});

test('unknown location goes to review rather than to a designer', () => {
  const d = qualify(call({ project: { locality: null, city: null } }));
  assert.equal(d.route, 'review');
});

test('unknown timeline still qualifies but is listed to confirm', () => {
  const d = qualify(call({ timeline: { weeks_until_needed: null, weeks_until_site_available: null, flexible: null, needed_by_text: null } }));
  assert.equal(d.route, 'qualified');
  assert.ok(d.confirm_at_consultation.some(q => /complete/.test(q)));
});

test('cost floor uses the low end of pricing.md', () => {
  assert.equal(costFloor({ scope_type: 'full_home', carpet_area_sqft: 1000 }), 1800000);
  assert.equal(costFloor({ segment: 'commercial', carpet_area_sqft: 1000 }), 1200000);
  assert.equal(costFloor({ scope_type: 'partial', room_count: 2 }), 700000);
});
