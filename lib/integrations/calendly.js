// Calendly: after a qualified call we create a single-use scheduling link and
// email it to the caller. The voice agent never books or promises a time.
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

// Looks up whether the invitee has booked (no paid webhook plan needed).
async function findBooking(email) {
  const me = await cal('GET', '/users/me');
  const params = new URLSearchParams({ user: me.resource.uri, invitee_email: email, status: 'active', count: '5' });
  const { collection } = await cal('GET', `/scheduled_events?${params}`);
  const ev = collection?.[0];
  return ev ? { start_time: ev.start_time, uri: ev.uri, name: ev.name } : null;
}

module.exports = { configured, createBookingLink, findBooking };
