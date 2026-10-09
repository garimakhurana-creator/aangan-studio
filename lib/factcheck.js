// Post-call fact-check of what the AGENT said. The prompt tells the agent not
// to invent things; this checks, in code, that it didn't. Any violation is
// stored on the call and raised on the dashboard / to Nikhil.
//
// turns:      [{ speaker: 'agent'|'caller', text }]
// toolEvents: [{ name, args, result }] from the live call

const { pricingViolations } = require('./guardrail');

// Numbers the agent may say on its own (kb/faq.md > Numbers the agent is allowed to say).
const APPROVED_NUMBERS = new Set([3, 4, 6, 8, 15, 16, 3000]);
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };

// Spelled-out numbers only count next to a unit, so "book one for you" or
// "two quick questions" aren't flagged but "twelve weeks" is. Digits always count.
const UNIT = '(weeks?|months?|days?|years?|lakhs?|lacs?|crores?|thousand|hundred|percent|per\\s*cent|sq|square|feet|ft|rooms?|bhk|rupees?|%)';

function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d,]*(\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, '')));
  const re = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b(?:\\s+(?:to|or|and|-)\\s+\\w+)?\\s+${UNIT}`, 'gi');
  for (const m of String(text).matchAll(re)) out.push(WORDS[m[1].toLowerCase()]);
  return out;
}

const BOOKED_CLAIM = /\b(you('|’)re|you are|that('|’)s|it('|’)s|is)\s+(all\s+)?(booked|confirmed|scheduled)\b|\bbooking\s+(is\s+)?confirmed\b|\bi('|’)ve\s+(booked|scheduled)\b/i;
const PROMISE_PERSON = /\b(nikhil|[A-Z][a-z]+)\s+will\s+(call|be calling|visit|meet|ring)\b|\byour designer (is|will be|named)\s+[A-Z]/;
const OFFERS = /\b(discount|cashback|warranty|guarantee[ds]?|% off|percent off|free (design|furniture|delivery|installation|site))\b/i;
const PAST_INTERACTION = /\b(i can see|our records show|you (called|spoke to us|enquired) (on|last))\b/i;

function factCheck(turns, toolEvents = []) {
  const violations = [];
  const callerNumbers = new Set(turns.filter(t => t.speaker === 'caller').flatMap(t => numbersIn(t.text)));
  const toolNumbers = new Set(toolEvents.flatMap(e => numbersIn(JSON.stringify(e.result || {}))));
  const confirmed = toolEvents.some(e => e.name === 'book_consultation' && e.result?.status === 'confirmed');
  const lookupKnown = toolEvents.some(e => e.name === 'lookup_caller' && e.result?.known);

  turns.forEach((t, i) => {
    if (t.speaker !== 'agent') return;
    const add = (type, detail) => violations.push({ turn: i, type, detail, text: t.text });

    // Restating the caller's own volunteered budget (qualified.md criterion 4:
    // "address the misalignment") isn't a quote; a figure the agent introduces is.
    const echoesCaller = numbersIn(t.text).length > 0 && numbersIn(t.text).every(n => callerNumbers.has(n));
    for (const v of pricingViolations(t.text)) if (!(v === 'money figure' && echoesCaller)) add('pricing', v);
    if (BOOKED_CLAIM.test(t.text) && !confirmed) add('false_booking', 'Said the booking was confirmed without a confirmed book_consultation result.');
    const person = t.text.match(PROMISE_PERSON);
    if (person && !/someone senior/i.test(t.text)) add('promised_person', `Promised a named person: "${person[0]}".`);
    const offer = t.text.match(OFFERS);
    if (offer) add('unapproved_offer', `Mentioned "${offer[0]}".`);
    if (PAST_INTERACTION.test(t.text) && !lookupKnown) add('invented_history', 'Referred to a past interaction the lookup did not return.');

    const strays = numbersIn(t.text).filter(n => !APPROVED_NUMBERS.has(n) && !callerNumbers.has(n) && !toolNumbers.has(n));
    if (strays.length) add('unapproved_number', `Said ${[...new Set(strays)].join(', ')}, which is not an approved figure, the caller's own detail, or a tool result.`);
  });

  return { ok: violations.length === 0, violations };
}

module.exports = { factCheck, numbersIn };
