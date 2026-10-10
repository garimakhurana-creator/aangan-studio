// Calendly: after a qualified call we book the earliest free slot matching the
// time the caller asked for; if none matches (or none was given) we email a
// single-use scheduling link instead. The voice agent never confirms a time.
//
// Env: CALENDLY_TOKEN (personal access token), CALENDLY_EVENT_TYPE_URI (studio
// consultation), optional CALENDLY_SITE_VISIT_EVENT_TYPE_URI.

const BASE = 'https://api.calendly.com';
const configured = () => Boolean(process.env.CALENDLY_TOKEN && process.env.CALENDLY_EVENT_TYPE_URI);

async function cal(method, route, body) {
  const res = await fetch(route.startsWith('http') ? route : `${BASE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CALENDLY_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${data.message || data.title || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function createBookingLink({ siteVisit, name, email }) {
  const owner = (siteVisit && process.env.CALENDLY_SITE_VISIT_EVENT_TYPE_URI) || process.env.CALENDLY_EVENT_TYPE_URI;
  const { resource } = await cal('POST', '/scheduling_links', { max_event_count: 1, owner, owner_type: 'EventType' });
  // Prefill so the caller doesn't retype what they told the agent.
  const url = new URL(resource.booking_url);
  if (name) url.searchParams.set('name', name);
  if (email) url.searchParams.set('email', email);
  return { url: url.toString(), event_type: owner };
}

const eventTypeFor = siteVisit => (siteVisit && process.env.CALENDLY_SITE_VISIT_EVENT_TYPE_URI) || process.env.CALENDLY_EVENT_TYPE_URI;

// Free slots for the next `days` days (Calendly allows 7 days per request).
async function availableTimes({ siteVisit, days = 14 } = {}) {
  const eventType = eventTypeFor(siteVisit);
  const from = Date.now() + 2 * 36e5; // a little notice so the slot is still free when we book
  const out = [];
  for (let start = from; start < from + days * 864e5; start += 7 * 864e5) {
    const end = Math.min(start + 7 * 864e5 - 6e4, from + days * 864e5);
    const params = new URLSearchParams({ event_type: eventType, start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString() });
    const { collection } = await cal('GET', `/event_type_available_times?${params}`);
    out.push(...(collection || []).filter(s => !s.status || s.status === 'available'));
  }
  return out;
}

// Books a slot directly for the caller (Calendly Scheduling API, paid plans).
// Calendly then sends the caller its own confirmation and calendar invite.
async function bookSlot({ siteVisit, startTime, name, email }) {
  const eventType = eventTypeFor(siteVisit);
  const { resource: et } = await cal('GET', eventType);
  const body = { event_type: eventType, start_time: startTime, invitee: { name: name || 'Aangan caller', email, timezone: 'Asia/Kolkata' } };
  const loc = (et.locations || [])[0];
  if (loc) body.location = { kind: loc.kind, ...(loc.location ? { location: loc.location } : {}) };
  const { resource } = await cal('POST', '/invitees', body);
  return { event_uri: resource.event, start_time: startTime, cancel_url: resource.cancel_url, reschedule_url: resource.reschedule_url };
}

// Looks up whether the invitee has booked (no paid webhook plan needed).
async function findBooking(email) {
  const me = await cal('GET', '/users/me');
  const params = new URLSearchParams({ user: me.resource.uri, invitee_email: email, status: 'active', count: '5' });
  const { collection } = await cal('GET', `/scheduled_events?${params}`);
  const ev = collection?.[0];
  return ev ? { start_time: ev.start_time, uri: ev.uri, name: ev.name } : null;
}

module.exports = { configured, createBookingLink, findBooking, availableTimes, bookSlot };
