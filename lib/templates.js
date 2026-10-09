// Email bodies. The designer handoff is the main product: everything the
// caller already said, so the designer's first call isn't spent re-asking.

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nice = s => String(s || '').replace(/_/g, ' ');
const ICON = { pass: '✅', unclear: '⚠️', fail: '❌' };
const FLAG_LABEL = {
  vip_referral: 'VIP — referred by a friend of Nikhil',
  repeat_caller: 'Repeat caller — earlier enquiry was not followed up',
  pricing_asked: 'Asked about price (deflected, not quoted)',
  proxy_caller: 'Calling on behalf of the decision-maker',
  rented: 'Rented home — no structural changes',
  large_project: 'Large project — principal designer',
  site_visit_requested: 'Wants a site visit',
  dropped_call: 'Call dropped and reconnected (merged)',
  tight_timeline: 'Tight timeline',
  budget_volunteered: 'Volunteered a budget',
  referral: 'Referral',
  structural_request: 'Mentioned structural work (we do not do this)',
};

function facts(x) {
  const p = x.project || {};
  const t = x.timeline || {};
  return [
    ['Project', [p.property_type, nice(p.scope_type)].filter(Boolean).join(' · ') || null],
    ['Rooms / spaces', (p.rooms || []).join(', ') || null],
    ['Location', [p.locality, p.city].filter(Boolean).join(', ') || null],
    ['Carpet area', p.carpet_area_sqft ? `${p.carpet_area_sqft} sq ft` : null],
    ['Current state', p.current_state],
    ['Owner / tenant', p.occupancy !== 'unknown' ? p.occupancy : null],
    ['Needed by', t.needed_by_text],
    ['Site available', t.site_available_text],
    ['Preferred start', t.preferred_start_text],
    ['Decision-maker', x.decision_maker?.detail || nice(x.decision_maker?.status)],
    ['Budget', x.budget?.volunteered ? `${x.budget.text} (volunteered)` : 'Not discussed (by policy, not asked)'],
    ['Found us via', [x.referral?.how_found, x.referral?.referrer_name].filter(Boolean).join(' — ') || null],
    ['Consultation', [x.requests?.site_visit ? 'Site visit' : 'Studio', x.requests?.preferred_slots].filter(Boolean).join(' · ')],
  ].filter(([, v]) => v);
}

function designerHandoff({ lead, acceptUrl, dashboardUrl }) {
  const x = lead.extraction;
  const d = lead.decision;
  const rows = facts(x);
  const flags = d.flags.map(f => FLAG_LABEL[f] || nice(f));
  const crit = Object.values(d.criteria);
  const booking = lead.booking?.status === 'link_sent'
    ? `Booking link emailed to ${lead.email}. You'll see the slot in Calendly once they pick it.`
    : lead.email ? 'Booking link not sent yet (see dashboard).' : 'No email captured — please call them to fix a time.';
  const subject = `${d.priority !== 'normal' ? `[${d.priority.toUpperCase()}] ` : ''}New qualified enquiry: ${x.caller_name || 'Caller'} · ${x.project?.property_type || 'project'}, ${x.project?.locality || 'Pune'}`;

  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1f2328;max-width:640px">
  <p style="margin:0 0 4px;color:#6b5b4b;font-size:12px;letter-spacing:.06em;text-transform:uppercase">Aangan Studio · new enquiry</p>
  <h2 style="margin:0 0 8px;font-size:20px">${esc(x.caller_name || 'Caller')} — ${esc(x.project?.property_type || 'project')}, ${esc(x.project?.locality || '')}</h2>
  <p style="margin:0 0 16px">${esc(x.summary)}</p>
  <p style="margin:0 0 16px"><a href="${esc(acceptUrl)}" style="background:#7a4e2d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">I've got this lead</a></p>
  ${flags.length ? `<p style="margin:0 0 16px">${flags.map(f => `<span style="display:inline-block;background:#f4ece4;border-radius:12px;padding:2px 10px;margin:2px 4px 2px 0;font-size:12px">${esc(f)}</span>`).join('')}</p>` : ''}
  <h3 style="font-size:15px;margin:16px 0 6px">Already asked — don't re-ask</h3>
  <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b5b4b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}
  <tr><td style="padding:4px 12px 4px 0;color:#6b5b4b">Phone</td><td>${esc(lead.phone || 'not captured')}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#6b5b4b">Email</td><td>${esc(lead.email || 'not captured')}</td></tr></table>
  <h3 style="font-size:15px;margin:16px 0 6px">Nikhil's five criteria</h3>
  <table style="border-collapse:collapse;width:100%">${crit.map(c => `<tr><td style="padding:4px 8px 4px 0;vertical-align:top">${ICON[c.status]}</td><td style="padding:4px 0"><b>${esc(c.name)}</b><br>${esc(c.reason)}${c.evidence?.length ? `<br><i style="color:#6b5b4b">“${esc(c.evidence[0])}”</i>` : ''}</td></tr>`).join('')}</table>
  ${d.confirm_at_consultation.length ? `<h3 style="font-size:15px;margin:16px 0 6px">Confirm at the consultation</h3><ul style="margin:0;padding-left:20px">${d.confirm_at_consultation.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
  <h3 style="font-size:15px;margin:16px 0 6px">Booking</h3><p style="margin:0">${esc(booking)}</p>
  <p style="margin:20px 0 0;font-size:12px;color:#6b5b4b">Policy ${esc(d.policy_version)} · <a href="${esc(dashboardUrl)}">Open in dashboard</a>${lead.recording_url ? ` · <a href="${esc(lead.recording_url)}">Call recording</a>` : ''}</p>
</div>`;

  const text = [
    subject, '', x.summary, '', `Accept: ${acceptUrl}`, '',
    flags.length ? `Flags: ${flags.join('; ')}` : null,
    'ALREADY ASKED — DON\'T RE-ASK', ...rows.map(([k, v]) => `- ${k}: ${v}`), `- Phone: ${lead.phone || 'not captured'}`, `- Email: ${lead.email || 'not captured'}`, '',
    'CRITERIA', ...crit.map(c => `${ICON[c.status]} ${c.name}: ${c.reason}`), '',
    d.confirm_at_consultation.length ? `CONFIRM AT CONSULTATION\n${d.confirm_at_consultation.map(q => `- ${q}`).join('\n')}\n` : null,
    `BOOKING: ${booking}`, `Dashboard: ${dashboardUrl}`,
  ].filter(v => v !== null).join('\n');
  return { subject, html, text };
}

function callerBookingLink({ name, bookingUrl, siteVisit }) {
  const hi = name ? `Hi ${name.split(' ')[0]},` : 'Hello,';
  const where = siteVisit ? 'a visit to your site' : 'a consultation at our studio';
  const subject = 'Pick a time for your Aangan Studio consultation';
  const text = `${hi}

Thank you for calling Aangan Studio. As promised, here is your link to pick a time for ${where} with one of our designers:

${bookingUrl}

The consultation is free and there's no obligation. Your designer will already have the details you shared on the call, so you won't need to repeat them.

Warm regards,
Aangan Studio, Pune`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#1f2328;max-width:560px">
<p>${esc(hi)}</p>
<p>Thank you for calling Aangan Studio. As promised, here is your link to pick a time for ${esc(where)} with one of our designers:</p>
<p><a href="${esc(bookingUrl)}" style="background:#7a4e2d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Pick a time</a></p>
<p>The consultation is free and there's no obligation. Your designer will already have the details you shared on the call, so you won't need to repeat them.</p>
<p>Warm regards,<br>Aangan Studio, Pune</p></div>`;
  return { subject, html, text };
}

module.exports = { designerHandoff, callerBookingLink, FLAG_LABEL };
