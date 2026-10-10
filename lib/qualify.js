// Deterministic rules engine. Gemini extracts facts from the call; this file
// applies Nikhil's five criteria (kb/qualified.md) using config/policy.json and
// decides the route. Same input + same policy version = same decision, with a
// reason code and evidence for every criterion.
//
// Routes:
//   qualified        all criteria pass (unclear 1/3/4/5 become "confirm at consultation")
//   declined         a clear fail on c1-c4, or two or more fails
//   nurture          only the timeline fails; follow up later
//   escalate         existing client with a problem; never treated as a lead
//   review           a human should look: unknown location, or the decision
//                    rests on a policy value Nikhil hasn't confirmed
//   no_conversation  missed or empty call; schedule a callback

const { loadPolicy, classifyLocality, costFloor } = require('./policy');

const CRITERIA = {
  c1: 'Real project (design + execution, in our scope)',
  c2: 'In our service area (Pune / PCMC)',
  c3: 'Realistic timeline',
  c4: 'Budget broadly aligned',
  c5: 'Decision-maker on the call or represented',
};

const pass = (reason, extra) => ({ status: 'pass', reason, ...extra });
const fail = (code, reason, extra) => ({ status: 'fail', code, reason, ...extra });
const unclear = (reason, extra) => ({ status: 'unclear', reason, ...extra });

function evidenceFor(x, key) {
  return (x.evidence || []).filter(e => e.criterion === key).map(e => e.quote);
}

function checkC1(x, policy, review) {
  const p = x.project || {};
  if (policy.segments.out_of_scope.includes(p.segment)) {
    return fail('SEGMENT_OUT_OF_SCOPE', `${p.property_type || p.segment} projects are outside what the studio designs.`);
  }
  if (x.engagement?.wants_design_and_execution === 'no') {
    return fail('ADVICE_ONLY', 'Caller wants advice or ideas, not design with execution.');
  }
  if (p.segment === 'commercial' && p.carpet_area_sqft) {
    const size = policy.commercial_size_sqft;
    if (p.carpet_area_sqft < size.min * size.hard_decline_below_fraction_of_min) {
      return fail('BELOW_MIN_SIZE', `${p.carpet_area_sqft} sq ft is far below the ${size.min} sq ft commercial minimum.`);
    }
    if (p.carpet_area_sqft < size.min && !size.min_confirmed) {
      review.push(`Commercial space of ${p.carpet_area_sqft} sq ft is under the unconfirmed ${size.min} sq ft minimum.`);
    }
    if (p.carpet_area_sqft > size.max) {
      review.push(`Commercial space of ${p.carpet_area_sqft} sq ft is above the ~${size.max} sq ft we usually take on.`);
    }
  }
  if (x.engagement?.wants_design_and_execution === 'unknown' || p.segment === 'unknown') {
    return unclear('Did not confirm a full design-and-execution project.');
  }
  return pass('Wants design and execution for an in-scope space.');
}

function checkC2(x, policy) {
  const p = x.project || {};
  const loc = classifyLocality(p.locality, p.city, policy);
  const where = [p.locality, p.city].filter(Boolean).join(', ');
  if (loc.status === 'in') return pass(`${where} is in the service area.`, { locality_match: loc.matched });
  if (loc.status === 'adjoining') {
    return pass(`${where} is treated as inside Pune/PCMC (not on the named list; confirm).`, { locality_match: loc.matched, confirm: true });
  }
  if (loc.status === 'out') return fail('OUT_OF_AREA', `${where} is outside Pune and PCMC.`, { locality_match: loc.matched });
  if (loc.status === 'city_only') return unclear('Only the city was mentioned, not which part of Pune.');
  return unclear('Location of the site was not captured.');
}

function checkC3(x, policy) {
  const t = x.timeline || {};
  const tl = policy.timeline;
  if (t.weeks_until_needed != null && t.weeks_until_needed < tl.hard_floor_weeks) {
    return fail('TIMELINE_TOO_SHORT', `Needs it done in about ${t.weeks_until_needed} weeks; the minimum is ${tl.hard_floor_weeks}.`);
  }
  if (t.weeks_until_site_available != null && t.weeks_until_site_available > tl.site_ready_max_weeks) {
    return fail('SITE_NOT_READY', `Site is only available in about ${t.weeks_until_site_available} weeks.`);
  }
  if (t.weeks_until_needed != null && t.weeks_until_needed < tl.comfortable_weeks) {
    return pass(`About ${t.weeks_until_needed} weeks: possible but tight.`, { tight: true });
  }
  if (t.weeks_until_needed == null && t.weeks_until_site_available == null && !t.flexible) {
    return unclear('No timeline was discussed.');
  }
  // A caller choosing to start later (T20 "January start would be ideal") is
  // their preference, not a site that can't be worked on.
  return pass(t.needed_by_text || t.preferred_start_text || t.site_available_text || 'Flexible timeline.');
}

function checkC4(x, policy) {
  const b = x.budget || {};
  if (!b.volunteered || b.max_inr == null) return pass('Budget not mentioned. Not probed, by policy.', { not_discussed: true });
  const floor = costFloor(x.project || {}, policy);
  if (floor == null) return unclear('Budget mentioned but scope too vague to judge.');
  if (b.max_inr < floor * policy.budget.misaligned_below_fraction_of_floor) {
    return fail('BUDGET_MISALIGNED', `Volunteered budget (${b.text || b.max_inr}) is clearly below any project of this scope.`);
  }
  return pass(`Volunteered budget (${b.text || b.max_inr}) is plausible for the scope.`);
}

function checkC5(x) {
  const d = x.decision_maker || {};
  switch (d.status) {
    case 'self':
    case 'authorised':
      return pass(d.detail || 'Caller is the decision-maker or authorised to proceed.');
    case 'proxy_decider_will_attend':
      return pass(d.detail || 'Calling for the owners, who will attend the consultation and decide.', { proxy: true });
    case 'research_only':
      return unclear(d.detail || 'Caller is researching for someone else who has not authorised them.', { proxy: true });
    default:
      return unclear('Did not establish who decides.');
  }
}

function qualify(x, policy = loadPolicy()) {
  const out = {
    policy_version: policy.version,
    route: null,
    criteria: {},
    reason_codes: [],
    flags: [],
    priority: 'normal',
    next_action: null,
    caller_line: null,
    confirm_at_consultation: [...(x.open_questions || [])],
    review_reasons: [],
  };
  const flag = f => { if (!out.flags.includes(f)) out.flags.push(f); };

  // Flags that matter whatever the route.
  if (x.pricing?.asked) flag('pricing_asked');
  if (x.referral?.knows_founder && policy.flags.vip_if_referrer_knows_founder) { flag('vip_referral'); out.priority = 'high'; }
  else if (x.referral?.referrer_name) flag('referral');
  if (x.repeat?.claims_prior_contact) { flag('repeat_caller'); out.priority = 'high'; }
  if (x.dropped_call) flag('dropped_call');
  if (x.requests?.site_visit) flag('site_visit_requested');
  if (x.project?.occupancy === 'tenant') flag('rented');
  if (x.project?.structural_changes) { flag('structural_request'); out.confirm_at_consultation.push('Caller mentioned structural work, which we do not do.'); }
  if (x.budget?.volunteered) flag('budget_volunteered');
  const big = (x.project?.carpet_area_sqft || 0) >= policy.flags.large_project_sqft
    || policy.flags.large_project_types.some(t => (x.project?.property_type || '').toLowerCase().includes(t));
  if (big) flag('large_project');

  // Not a new sales conversation.
  if (x.call_type === 'no_conversation') {
    out.route = 'no_conversation';
    out.next_action = 'callback';
    out.reason_codes.push('NO_CONVERSATION');
    return out;
  }
  if (x.call_type === 'existing_client_issue' || x.complaint?.is_existing_client) {
    out.route = 'escalate';
    out.priority = 'urgent';
    out.next_action = 'alert_nikhil';
    out.reason_codes.push('EXISTING_CLIENT_ISSUE');
    out.caller_line = policy.approved_lines.escalate_complaint;
    return out;
  }
  if (x.call_type === 'non_sales') {
    out.route = 'review';
    out.next_action = 'human_review';
    out.reason_codes.push('NON_SALES_CALL');
    out.review_reasons.push('Not a project enquiry (vendor, job seeker, or other).');
    return out;
  }

  const review = out.review_reasons;
  const c = {
    c1: checkC1(x, policy, review),
    c2: checkC2(x, policy),
    c3: checkC3(x, policy),
    c4: checkC4(x, policy),
    c5: checkC5(x),
  };
  for (const [k, v] of Object.entries(c)) {
    out.criteria[k] = { name: CRITERIA[k], ...v, evidence: evidenceFor(x, k) };
    if (v.code) out.reason_codes.push(v.code);
  }

  if (c.c2.confirm) out.confirm_at_consultation.push(`Confirm ${x.project.locality} is within our area.`);
  if (c.c3.tight) {
    flag('tight_timeline');
    out.confirm_at_consultation.push('Timeline is tight. Confirm the completion date is firm before committing.');
  }
  if (c.c5.proxy) flag('proxy_caller');
  if (c.c1.status === 'unclear') out.confirm_at_consultation.push('Confirm they want full design and execution, not advice.');
  if (c.c3.status === 'unclear') out.confirm_at_consultation.push('When does the project need to be complete, and when is the site available?');
  if (c.c5.status === 'unclear') out.confirm_at_consultation.push('Confirm who makes the final decision and that they will attend.');

  const fails = Object.keys(c).filter(k => c[k].status === 'fail');
  const rules = policy.decision_rules;
  const L = policy.approved_lines;

  if (fails.length === 0) {
    if (c.c2.status === 'unclear') {
      // The call ended (or wandered) before we learned where the site is.
      const missing = [c.c2.status === 'unclear' && 'which area the site is in', c.c1.status === 'unclear' && 'what they want done', c.c3.status === 'unclear' && 'when they need it', !x.requests?.email && !x.caller_name && 'their name or email'].filter(Boolean);
      review.push(`The call ended before we learned ${missing.join(', ')}. Call them back before sending it to a designer.`);
    }
    if (review.length) {
      out.route = 'review';
      out.next_action = 'human_review';
    } else {
      out.route = 'qualified';
      out.next_action = 'book_consultation';
      out.caller_line = null;
    }
  } else if (fails.length === 1 && fails[0] === 'c3') {
    out.route = rules.c3_only_fail_route;
    out.next_action = 'create_followup_task';
    out.caller_line = L.nurture_timeline;
  } else if (fails.length === 1 && fails[0] === 'c5') {
    out.route = rules.c5_only_fail_route;
    out.next_action = 'human_review';
  } else {
    out.route = 'declined';
    out.next_action = 'log_decline';
    const code = out.reason_codes[0];
    out.caller_line = fails.length >= 2 ? L.decline_multi
      : code === 'OUT_OF_AREA' ? L.decline_area
      : code === 'ADVICE_ONLY' ? L.decline_advice_only
      : code === 'SEGMENT_OUT_OF_SCOPE' ? L.decline_segment
      : code === 'BELOW_MIN_SIZE' ? L.decline_size
      : code === 'BUDGET_MISALIGNED' ? L.decline_budget
      : L.decline_multi;
  }

  if (out.route === 'qualified' && out.flags.includes('repeat_caller')) {
    out.confirm_at_consultation.unshift('Caller says an earlier enquiry was not followed up. Open with an apology.');
  }
  return out;
}

module.exports = { qualify, CRITERIA };
