const test = require('node:test');
const assert = require('node:assert/strict');
const { factCheck } = require('../lib/factcheck');
const { verifyExtraction } = require('../lib/verify-extraction');

const agent = text => ({ speaker: 'agent', text });
const caller = text => ({ speaker: 'caller', text });

test('a clean call passes the fact-check', () => {
  const r = factCheck([
    caller('Hi, 2BHK in Wakad, 950 square feet, full redesign.'),
    agent('Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation.'),
    agent('Design takes three to four weeks, then execution is eight to sixteen weeks.'),
    agent('So that is 950 square feet in Wakad. You\'re booked for Saturday at 11.'),
  ], [{ name: 'book_consultation', result: { status: 'confirmed', start: 'Saturday 11:00' } }]);
  assert.deepEqual(r.violations, []);
});

test('claiming a booking without a confirmed tool result is caught', () => {
  const r = factCheck([agent('Great, you\'re booked for Monday.')], [{ name: 'book_consultation', result: { status: 'failed' } }]);
  assert.equal(r.violations[0].type, 'false_booking');
});

test('invented numbers, people, offers and history are caught', () => {
  const types = t => factCheck([caller('3BHK in Aundh'), agent(t)]).violations.map(v => v.type);
  assert.ok(types('Your project will take about 12 weeks.').includes('unapproved_number'));
  assert.ok(types('Aryan will call you tomorrow.').includes('promised_person'));
  assert.ok(types('We can give you a festive discount.').includes('unapproved_offer'));
  assert.ok(types('We offer a 10 year warranty on wardrobes.').includes('unapproved_offer'));
  assert.ok(types('I can see you called us last week.').includes('invented_history'));
  assert.ok(types('That will be around 12 lakh.').includes('pricing'));
});

test('free consultation and a senior callback are allowed', () => {
  assert.ok(factCheck([agent('The consultation is free and there\'s no obligation.')]).ok);
  assert.ok(factCheck([agent('Someone senior will call you back within 15 minutes.')]).ok);
});

const transcript = `Front Desk: Good morning, Aangan Studio.
Caller: Hi, I'm Priya. I got your number from a friend — Shruti Joshi.
Caller: We have a 3BHK in Kothrud — Dahanukar Colony. About 1,400 sq ft carpet.`;

test('grounded facts survive verification', () => {
  const { extraction, warnings } = verifyExtraction({
    caller_name: 'Priya',
    referral: { referrer_name: 'Shruti Joshi', knows_founder: false },
    project: { locality: 'Kothrud, Dahanukar Colony', city: 'Pune', carpet_area_sqft: 1400 },
    budget: { volunteered: false, max_inr: null, text: null },
    evidence: [{ criterion: 'c2', quote: 'We have a 3BHK in Kothrud — Dahanukar Colony.' }],
  }, transcript);
  assert.deepEqual(warnings, []);
  assert.equal(extraction.project.carpet_area_sqft, 1400);
  assert.equal(extraction.evidence.length, 1);
});

test('invented facts are removed with a warning', () => {
  const { extraction, warnings } = verifyExtraction({
    caller_name: 'Anjali',
    referral: { referrer_name: 'Vikram', knows_founder: true },
    project: { locality: 'Baner', city: null, carpet_area_sqft: 1200 },
    budget: { volunteered: true, max_inr: 1500000, text: '15 lakh' },
    evidence: [{ criterion: 'c3', quote: 'We need it done by December for the wedding' }],
  }, transcript);
  assert.equal(extraction.caller_name, null);
  assert.equal(extraction.referral.referrer_name, null);
  assert.equal(extraction.referral.knows_founder, false);
  assert.equal(extraction.project.locality, null);
  assert.equal(extraction.project.carpet_area_sqft, null);
  assert.equal(extraction.budget.volunteered, false);
  assert.equal(extraction.evidence.length, 0);
  assert.equal(warnings.length, 7);
});

test('spelled-out numbers only count next to a unit', () => {
  assert.ok(factCheck([agent('Would you like me to book one for you? Just two quick questions first.')]).ok);
  assert.ok(factCheck([agent("I'm sorry we can't help with this one.")]).ok);
  assert.equal(factCheck([agent('It will take about twelve weeks.')]).violations[0].type, 'unapproved_number');
  assert.ok(factCheck([agent('Design takes three to four weeks.')]).ok);
});

test("restating the caller's own budget is allowed; adding a figure is not", () => {
  const c = caller('My budget is 1 to 1.5 lakh maximum.');
  assert.ok(factCheck([c, agent('For that scope, 1 to 1.5 lakh would be well below what a project with us would cost.')]).ok);
  assert.equal(factCheck([c, agent('That would need at least 7 lakh.')]).violations[0].type, 'pricing');
  assert.ok(factCheck([c, agent('Our rates start at 1 lakh per room.')]).violations.some(v => v.type === 'pricing'));
});
