// Vaani webhook normalisation and call-history enrichment.
// Docs: https://docs.vaanivoice.ai/guides/webhook-setup

const API = 'https://api.vaanivoice.ai/api';

// Returns { event, call_id, ... } in one shape regardless of event type.
function normalizeWebhook(body) {
  const event = body?.event;
  if (event === 'call_postprocessing') {
    const d = body.data || {};
    return {
      event,
      call_id: body.call_id || d.call_id || d.room_name,
      ended_at: body.timestamp || new Date().toISOString(),
      duration_s: d.call_duration != null ? Math.round(d.call_duration / 1000) : null, // ms in this event
      end_reason: d.end_reason || null,
      transcript: d.transcript || '',
      summary: d.summary || null,
      entities: d.entities || {},
      recording_url: d.recording_url || null,
    };
  }
  return {
    event,
    call_id: body?.call_id || body?.room_name,
    phone: body?.phone_number || null,
    duration_s: event === 'call_ended' ? body.call_duration : null, // seconds in this event
    end_reason: body?.end_reason || null,
  };
}

// "[13:33:14] AGENT: Hi..." / "AGENT: ..." / "Front Desk: ..." / "Caller: ..."
function parseTranscript(text) {
  const turns = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:\[[\d:]+\]\s*)?(AGENT|USER|ASSISTANT|BOT|Agent|User|Front Desk|Caller|Shruti)\s*:\s*(.*)$/i);
    if (m) {
      const who = m[1].toLowerCase();
      turns.push({ speaker: ['user', 'caller'].includes(who) ? 'caller' : 'agent', text: m[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += ` ${line}`;
    } else {
      turns.push({ speaker: 'meta', text: line });
    }
  }
  return turns;
}

const transcriptForExtraction = turns => turns
  .map(t => (t.speaker === 'meta' ? t.text : `${t.speaker === 'agent' ? 'Agent' : 'Caller'}: ${t.text}`))
  .join('\n');

// Caller number and Vaani's own cost for a call, from call history.
async function fetchCallInfo(callId) {
  if (!process.env.VAANI_API_KEY) return null;
  const res = await fetch(`${API}/call-history?page=1&page_size=100`, { headers: { 'X-API-Key': process.env.VAANI_API_KEY } });
  if (!res.ok) throw new Error(`Vaani call-history ${res.status}`);
  const { data } = await res.json();
  const c = (data || []).find(x => x.call_id === callId);
  if (!c) return null;
  const inbound = /inbound/i.test(c.direction || c.call_type || '');
  return {
    phone: inbound ? c.from_number : c.to_number,
    cost_credits: c.call_cost ?? null,
    started_at: c.Start_time || null,
    picked_up_at: c.user_picked_up_at || null,
    agent_id: c.agent_id,
  };
}

module.exports = { normalizeWebhook, parseTranscript, transcriptForExtraction, fetchCallInfo };
