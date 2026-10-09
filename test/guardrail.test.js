const test = require('node:test');
const assert = require('node:assert/strict');
const { pricingViolations } = require('../lib/guardrail');
const { loadPolicy } = require('../lib/policy');

test('every approved caller line is clean', () => {
  for (const [name, line] of Object.entries(loadPolicy().approved_lines)) {
    assert.deepEqual(pricingViolations(line), [], name);
  }
});

test('repeating the caller\'s area is allowed', () => {
  for (const ok of [
    'So that is a 3BHK of about 1,400 sq ft in Kothrud.',
    'A 950 square foot flat in Wakad, full redesign. Got it.',
    'Design takes three to four weeks, and execution eight to sixteen.',
    'Can I book you for Saturday at 10:30?',
  ]) assert.deepEqual(pricingViolations(ok), [], ok);
});

test('every way of leaking a price is caught', () => {
  for (const bad of [
    'Our rates start at 1,800 per square foot.',
    'It\'ll cost around 12 lakh for a 2BHK.',
    'For a 2BHK it\'s typically 10 to 15 lakh.',
    'Roughly ₹2,000/sq ft for standard.',
    'Most kitchens come in under Rs 4 lakh.',
    'Somewhere between 8 and 14 lakhs.',
    'Approximately 2400 psf for premium.',
    'Lagbhag das lakh lagega.',
    'करीब 10 लाख का खर्च आएगा।',
    'Single rooms start from 3.5 L.',
  ]) assert.notDeepEqual(pricingViolations(bad), [], bad);
});
