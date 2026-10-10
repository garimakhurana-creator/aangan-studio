// Turns a caller's stated preference ("Saturday morning", "weekday evenings",
// "Monday at 11") into one free Calendly slot. Pure functions, all times IST.
// Books only when the caller actually stated a preference; otherwise the
// caller gets a link and chooses themselves.

const IST_MS = 5.5 * 36e5;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
// Hours of the day, IST, for each part of day.
const PARTS = { morning: [9, 12], afternoon: [12, 16], evening: [16, 21], any: [0, 24] };

function ist(iso) {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  return { day: DAYS[d.getUTCDay()], date: d.toISOString().slice(0, 10), hour: d.getUTCHours() + d.getUTCMinutes() / 60 };
}

function hasPreference(p) {
  return Boolean(p && ((p.days && p.days.length) || (p.part_of_day && p.part_of_day !== 'any') || p.specific_time || p.specific_date));
}

function wantedDays(p) {
  return new Set((p.days || []).flatMap(d => {
    const k = String(d).toLowerCase();
    return k === 'weekday' ? WEEKDAYS : k === 'weekend' ? ['saturday', 'sunday'] : [k];
  }));
}

function toHours(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

// slots: [{ start_time: ISO }] from Calendly, already free.
function pickSlot(slots, pref) {
  if (!hasPreference(pref)) return null;
  const days = wantedDays(pref);
  const [lo, hi] = PARTS[pref.part_of_day] || PARTS.any;
  const target = toHours(pref.specific_time);
  const fits = slots.filter(s => {
    const t = ist(s.start_time);
    if (pref.specific_date && t.date !== pref.specific_date) return false;
    if (days.size && !days.has(t.day)) return false;
    if (target != null) return Math.abs(t.hour - target) <= 1;
    return t.hour >= lo && t.hour < hi;
  });
  if (!fits.length) return null;
  fits.sort((a, b) => a.start_time.localeCompare(b.start_time));
  if (target == null) return fits[0];
  // A named time: the earliest day that has it, then the slot closest to it.
  const firstDay = ist(fits[0].start_time).date;
  return fits.filter(s => ist(s.start_time).date === firstDay)
    .sort((a, b) => Math.abs(ist(a.start_time).hour - target) - Math.abs(ist(b.start_time).hour - target))[0];
}

// "Saturday 17 Oct, 10:00 am" for emails and messages.
function describeSlot(iso) {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

module.exports = { pickSlot, hasPreference, describeSlot, ist };
