const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSlot, hasPreference, ist } = require('../lib/slots');

// Free slots, given in IST for readability: Mon 12 Oct to Sat 17 Oct 2026.
const istToUtc = s => new Date(`${s}:00+05:30`).toISOString();
const slots = [
  '2026-10-12T09:00', '2026-10-12T11:00', '2026-10-12T18:30', // Monday
  '2026-10-14T14:00',                                          // Wednesday
  '2026-10-17T10:00', '2026-10-17T10:30', '2026-10-17T15:00',  // Saturday
].map(s => ({ start_time: istToUtc(s) }));
const at = s => ist(s.start_time).day + ' ' + ist(s.start_time).hour;

test('no stated preference means no auto-booking', () => {
  assert.equal(hasPreference({ days: [], part_of_day: 'any', specific_time: null, specific_date: null }), false);
  assert.equal(pickSlot(slots, { days: [], part_of_day: 'any' }), null);
});

test('"Saturday morning" books the earliest Saturday morning slot', () => {
  assert.equal(at(pickSlot(slots, { days: ['saturday'], part_of_day: 'morning' })), 'saturday 10');
});

test('"weekday evenings" books Monday 6:30 pm', () => {
  assert.equal(at(pickSlot(slots, { days: ['weekday'], part_of_day: 'evening' })), 'monday 18.5');
});

test('"Monday at 11" books exactly that', () => {
  assert.equal(at(pickSlot(slots, { days: ['monday'], part_of_day: 'any', specific_time: '11:00' })), 'monday 11');
});

test('a specific date and time picks the closest slot within an hour', () => {
  assert.equal(at(pickSlot(slots, { days: [], part_of_day: 'any', specific_date: '2026-10-17', specific_time: '10:15' })), 'saturday 10');
});

test('nothing matching returns null, so the caller gets a link instead', () => {
  assert.equal(pickSlot(slots, { days: ['sunday'], part_of_day: 'morning' }), null);
  assert.equal(pickSlot(slots, { days: ['wednesday'], part_of_day: 'morning' }), null);
});
