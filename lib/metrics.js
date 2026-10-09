// Every number on the dashboard, computed from stored records. Each metric
// carries its definition so Nikhil can see exactly what it counts.
// Simulated calls (replayed transcripts) are excluded unless asked for.

const fs = require('fs');
const path = require('path');
const { loadPolicy } = require('./policy');

const ROOT = path.join(__dirname, '..');
const readJson = (p, fallback = null) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8')); } catch { return fallback; } };

const median = arr => {
  const a = arr.filter(n => n != null && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const secs = (from, to) => (from && to ? (new Date(to) - new Date(from)) / 1000 : null);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// Office hours are 10am–7pm IST (case brief).
const istHour = iso => Math.floor(((new Date(iso).getTime() / 36e5) + 5.5) % 24);
function afterHours(iso) {
  const h = istHour(iso);
  return h < 10 || h >= 19;
}

// Start of the selected period (IST calendar for "month").
function periodStart(period, now = new Date()) {
  if (period === '7d') return new Date(now - 7 * 864e5);
  if (period === '30d') return new Date(now - 30 * 864e5);
  if (period === 'month') {
    const ist = new Date(now.getTime() + 5.5 * 36e5);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 36e5);
  }
  return null;
}

function inScope({ includeSimulated, period }) {
  const from = periodStart(period);
  return (r, at) => (includeSimulated || !r.simulated) && (!from || (at && new Date(at) >= from));
}

// What needs a human, most urgent first. A lead leaves the list once handled.
const SEVERITY = { critical: 0, serious: 1, warning: 2, info: 3 };
function attentionItems(leads, policy) {
  const items = [];
  for (const l of leads) {
    if (l.handled_at) continue;
    const who = l.name || l.phone || 'Unknown caller';
    const add = (severity, kind, title, detail, actions) => items.push({ lead_id: l.id, severity, kind, who, title, detail, actions, at: l.last_call_at, simulated: !!l.simulated, route: l.decision?.route, qualified: l.decision?.route === 'qualified', project: [l.extraction?.project?.property_type, l.extraction?.project?.locality].filter(Boolean).join(' · ') });
    const route = l.decision?.route;
    if (route === 'escalate') add('critical', 'complaint', 'Existing client wants a senior callback', l.extraction?.complaint?.detail || l.extraction?.summary, ['handled']);
    if (l.factcheck && !l.factcheck.ok) add('serious', 'factcheck', 'The agent said something unapproved', `“${l.factcheck.violations[0].text.slice(0, 110)}”`, ['open', 'handled']);
    // action_status holds each action's latest outcome, so a retry that succeeds clears it.
    const failing = Object.keys(l.action_status || {}).filter(k => l.action_status[k] === 'failed');
    if (failing.length) add('serious', 'failed', `${failing.length} action${failing.length > 1 ? 's' : ''} failed`, failing.join(', ').replace(/_/g, ' '), ['retry', 'open']);
    if (l.handoff?.status === 'sent' && Date.now() - new Date(l.handoff.sent_at) > policy.sla.designer_accept_hours * 36e5) {
      add('serious', 'sla', `Not picked up in ${policy.sla.designer_accept_hours}h`, `Sent to ${l.assigned_to?.name || 'designer'}`, ['open', 'handled']);
    }
    if (route === 'review') add('warning', 'review', 'Needs your decision', (l.decision.review_reasons || []).join(' '), ['approve', 'decline']);
    if (route === 'qualified' && l.booking?.status === 'no_email') add('info', 'no_email', 'No email for the booking link', 'Their designer has been asked to call to fix a time', ['handled']);
    if (route === 'no_conversation') add('info', 'callback', 'Call with no conversation', 'Worth a callback', ['handled']);
  }
  return items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.at.localeCompare(a.at));
}

function computeMetrics({ leads: allLeads, calls: allCalls, events: allEvents, includeSimulated = false, period = 'all' }) {
  const keep = inScope({ includeSimulated, period });
  const leads = allLeads.filter(l => keep(l, l.last_call_at));
  const calls = allCalls.filter(c => keep(c, c.ended_at));
  const leadIds = new Set(leads.map(l => l.id));
  const events = allEvents.filter(e => (includeSimulated || !e.simulated) && (!e.lead_id || leadIds.has(e.lead_id)));
  const policy = loadPolicy();
  const costs = readJson('config/costs.json', {});

  const by = route => leads.filter(l => l.decision?.route === route);
  const qualified = by('qualified');
  const linkSent = qualified.filter(l => ['link_sent', 'booked'].includes(l.booking?.status));
  const booked = leads.filter(l => l.booking?.status === 'booked');
  const accepted = leads.filter(l => l.handoff?.status === 'accepted');
  const handedOff = leads.filter(l => l.handoff?.sent_at);
  const pricingAsked = leads.filter(l => l.decision?.flags?.includes('pricing_asked'));

  const reasons = {};
  for (const l of leads) for (const r of l.decision?.reason_codes || []) reasons[r] = (reasons[r] || 0) + 1;

  // Cost: only from rates the studio has set.
  const credits = leads.reduce((s, l) => s + (l.costs?.vaani_credits || 0), 0);
  const inTok = leads.reduce((s, l) => s + (l.costs?.gemini_input_tokens || 0), 0);
  const outTok = leads.reduce((s, l) => s + (l.costs?.gemini_output_tokens || 0), 0);
  const vaaniInr = costs.vaani_inr_per_credit != null ? credits * costs.vaani_inr_per_credit : null;
  const geminiInr = costs.gemini_inr_per_million_input_tokens != null && costs.gemini_inr_per_million_output_tokens != null
    ? (inTok / 1e6) * costs.gemini_inr_per_million_input_tokens + (outTok / 1e6) * costs.gemini_inr_per_million_output_tokens : null;
  const variable = vaaniInr != null && geminiInr != null ? vaaniInr + geminiInr : null;
  const per = n => (variable != null && n ? Math.round((variable / n) * 100) / 100 : null);
  const fixed = Object.values(costs.fixed_monthly_inr || {});

  const failed = events.filter(e => e.status === 'failed');
  const skipped = events.filter(e => e.status === 'skipped');
  const evalSummary = readJson('eval/results.json')?.summary || null;
  const redteam = readJson('eval/redteam-results.json')?.summary || null;

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0, after_hours: h < 10 || h >= 19 }));
  for (const c of calls) if (c.ended_at) hourly[istHour(c.ended_at)].calls++;

  const m = {
    generated_at: new Date().toISOString(),
    includes_simulated: includeSimulated,
    period,
    period_start: periodStart(period)?.toISOString() || null,
    policy_version: policy.version,
    attention: attentionItems(leads, policy),
    hourly: { data: hourly, office_hours: [10, 19], def: 'Calls by hour of day (IST). The shaded band is when the front desk is staffed.' },
    response: {
      calls: { value: calls.length, def: 'Calls received by the AI front desk.' },
      after_hours: { value: calls.filter(c => c.ended_at && afterHours(c.ended_at)).length, def: 'Calls that ended outside 10am–7pm IST, when the front desk is closed.' },
      answered_pct: { value: calls.length ? 100 : null, def: 'Every call is answered live by the AI agent; there is no voicemail path.' },
      median_handoff_s: { value: median(handedOff.map(l => secs(l.timing?.call_ended_at, l.handoff.sent_at))), def: 'Median seconds from call end to the designer handoff email being sent.' },
      median_accept_min: { value: (v => (v == null ? null : Math.round(v / 6) / 10))(median(accepted.map(l => secs(l.handoff.sent_at, l.handoff.accepted_at)))), def: 'Median minutes from handoff email to the designer clicking "I\'ve got this".' },
      awaiting_accept: { value: leads.filter(l => l.handoff?.status === 'sent').length, def: `Handoffs sent but not yet accepted (Nikhil is nudged after ${policy.sla.designer_accept_hours}h).` },
    },
    funnel: [
      { key: 'enquiries', label: 'Unique enquiries', value: leads.length, def: 'One per caller per enquiry; a dropped call and its callback count once.' },
      { key: 'qualified', label: 'Qualified', value: qualified.length, def: 'Passed all five of Nikhil\'s criteria.' },
      { key: 'link_sent', label: 'Booking link sent', value: linkSent.length, def: 'Qualified enquiries emailed a Calendly link.' },
      { key: 'booked', label: 'Consultation booked', value: booked.length, def: 'Picked a time in Calendly.' },
      { key: 'accepted', label: 'Designer accepted', value: accepted.length, def: 'Designer clicked "I\'ve got this" in the handoff email.' },
    ],
    routes_def: 'Where each unique enquiry ended up.',
    routes: Object.fromEntries(['qualified', 'review', 'nurture', 'declined', 'escalate', 'no_conversation'].map(r => [r, by(r).length])),
    decline_reasons: reasons,
    pricing: {
      asked: pricingAsked.length,
      asked_and_qualified: pricingAsked.filter(l => l.decision.route === 'qualified').length,
      asked_and_booked: pricingAsked.filter(l => l.booking?.status === 'booked').length,
      quoted: 0,
      def: 'Callers who asked about price. The agent never quotes (pricing.md); this shows whether deflecting costs bookings.',
    },
    cost: {
      vaani_credits: credits,
      gemini_tokens: { input: inTok, output: outTok },
      vaani_inr: vaaniInr,
      gemini_inr: geminiInr,
      variable_inr: variable,
      per_call_inr: per(calls.length),
      per_qualified_inr: per(qualified.length),
      per_booking_inr: per(booked.length),
      fixed_monthly_inr: fixed.some(v => v == null) ? null : fixed.reduce((s, v) => s + v, 0),
      rates_missing: [
        costs.vaani_inr_per_credit == null && 'Vaani ₹ per credit',
        geminiInr == null && 'Gemini ₹ per million tokens',
        fixed.some(v => v == null) && 'Calendly plan',
      ].filter(Boolean),
      def: 'Variable cost is measured per call (Vaani credits, Gemini tokens) and priced with config/costs.json.',
    },
    value: {
      avg_project_value_inr: costs.business?.avg_project_value_inr ?? null,
      consultation_to_project_rate: costs.business?.consultation_to_project_rate ?? null,
      projected_projects: costs.business?.consultation_to_project_rate != null ? Math.round(booked.length * costs.business.consultation_to_project_rate * 10) / 10 : null,
      label: 'Projection',
      def: 'Bookings × Aangan\'s own consultation-to-project rate × average project value. Hidden until the rate is set.',
    },
    health: {
      integration_failures: failed.length,
      not_configured: [...new Set(skipped.map(e => e.type))],
      factcheck_violations: leads.reduce((s, l) => s + (l.factcheck?.violations?.length || 0), 0),
      grounding_removed_facts: leads.reduce((s, l) => s + (l.grounding_warnings?.length || 0), 0),
      pricing_quotes: leads.reduce((s, l) => s + (l.factcheck?.violations || []).filter(v => v.type === 'pricing').length, 0),
      review_queue: by('review').length,
      redteam: redteam ? { passed: redteam.passed, total: redteam.total, run_at: redteam.run_at } : null,
      eval: evalSummary ? { passed: evalSummary.passed, total: evalSummary.total, run_at: evalSummary.run_at, policy_version: evalSummary.policy_version } : null,
      unconfirmed_policy: [
        !policy.timeline.comfortable_confirmed && 'Timeline: 6 vs 8–10 weeks',
        !policy.commercial_size_sqft.min_confirmed && 'Commercial minimum 500 sq ft',
        !policy.decision_rules.confirmed && 'Single-fail vs two-fail rule',
        !policy.budget.confirmed && 'Budget floor',
      ].filter(Boolean),
    },
    baseline: {
      label: 'Case baseline (Nikhil\'s manual count, last month)',
      enquiries_per_month: 200,
      no_reply_48h_pct: 48,
      outside_hours_pct: 33,
      conversion_multiple_within_1h: 4,
    },
  };
  return m;
}

module.exports = { computeMetrics, afterHours, periodStart };
