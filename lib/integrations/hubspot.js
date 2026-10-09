// HubSpot CRM via a private-app token (HUBSPOT_ACCESS_TOKEN). Scopes needed:
// crm.objects.contacts.read/write, crm.objects.deals.read/write.
// Contacts are matched by phone so a repeat caller updates one record.

const BASE = 'https://api.hubapi.com';
const configured = () => Boolean(process.env.HUBSPOT_ACCESS_TOKEN);

// HubSpot-defined association type ids (v4).
const ASSOC = { deal_to_contact: 3, note_to_contact: 202, note_to_deal: 214, task_to_contact: 204 };

async function hs(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const assoc = (id, typeId) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] });

async function upsertContact({ phone, name, email, locality }) {
  const [firstname, ...rest] = String(name || '').trim().split(/\s+/);
  const properties = {
    ...(firstname ? { firstname } : {}),
    ...(rest.length ? { lastname: rest.join(' ') } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(locality ? { city: locality } : {}),
  };
  let existing = null;
  if (phone) {
    const found = await hs('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }], limit: 1,
    });
    existing = found.results?.[0] || null;
  }
  if (existing) {
    await hs('PATCH', `/crm/v3/objects/contacts/${existing.id}`, { properties });
    return { id: existing.id, created: false };
  }
  const created = await hs('POST', '/crm/v3/objects/contacts', { properties });
  return { id: created.id, created: true };
}

// Default sales pipeline stages.
const STAGE = { link_sent: 'qualifiedtobuy', booked: 'appointmentscheduled' };

async function createDeal({ contactId, name, stage = 'link_sent' }) {
  const deal = await hs('POST', '/crm/v3/objects/deals', {
    properties: { dealname: name, pipeline: 'default', dealstage: STAGE[stage] },
    associations: [assoc(contactId, ASSOC.deal_to_contact)],
  });
  return { id: deal.id };
}

async function updateDealStage(dealId, stage) {
  await hs('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: { dealstage: STAGE[stage] } });
}

async function addNote({ contactId, dealId, body }) {
  const associations = [assoc(contactId, ASSOC.note_to_contact)];
  if (dealId) associations.push(assoc(dealId, ASSOC.note_to_deal));
  const note = await hs('POST', '/crm/v3/objects/notes', {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
    associations,
  });
  return { id: note.id };
}

async function addTask({ contactId, subject, body, dueAt }) {
  const task = await hs('POST', '/crm/v3/objects/tasks', {
    properties: { hs_timestamp: dueAt, hs_task_subject: subject, hs_task_body: body, hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM' },
    associations: [assoc(contactId, ASSOC.task_to_contact)],
  });
  return { id: task.id };
}

module.exports = { configured, upsertContact, createDeal, updateDealStage, addNote, addTask };
