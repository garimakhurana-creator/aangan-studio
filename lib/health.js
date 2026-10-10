// Live checks for the uptime monitor (.github/workflows/uptime.yml): each one
// makes a cheap read-only call to a service the front desk depends on.

const fs = require('fs');
const path = require('path');
const { store } = require('./store');

const agentId = () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'vaani-agent.json'), 'utf8')).agent_id; } catch { return null; }
};

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}${body.message ? `: ${body.message}` : ''}`);
  return body;
}

const CHECKS = {
  async database() {
    if (store().name !== 'neon') throw new Error(`storage is "${store().name}", not Neon — data would be lost`);
    await store().get('events', '__health__');
  },
  async gemini() {
    await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${process.env.GEMINI_API_KEY}`);
  },
  async vaani() {
    const id = agentId();
    if (!id) throw new Error('no agent id in config/vaani-agent.json');
    const a = await getJson(`https://api.vaanivoice.ai/api/agent/${id}`, { 'X-API-Key': process.env.VAANI_API_KEY });
    const hooks = [a.webhook].flat().filter(Boolean);
    const ours = JSON.stringify(hooks).includes('/api/vaani/webhook');
    if (hooks.length && !ours) throw new Error('the agent no longer sends calls to this site (webhook changed)');
  },
  async calendly() {
    const { resource } = await getJson(process.env.CALENDLY_EVENT_TYPE_URI, { Authorization: `Bearer ${process.env.CALENDLY_TOKEN}` });
    if (resource.active === false) throw new Error('the consultation event type is turned off in Calendly');
  },
  async hubspot() {
    await getJson('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` });
  },
  async telegram() {
    const r = await getJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!r.ok) throw new Error('bot token rejected');
  },
  async email() {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  },
};

async function deepHealth() {
  const entries = await Promise.all(Object.entries(CHECKS).map(async ([name, fn]) => {
    const t = Date.now();
    try { await fn(); return [name, { ok: true, ms: Date.now() - t }]; } catch (err) { return [name, { ok: false, ms: Date.now() - t, error: err.message }]; }
  }));
  const checks = Object.fromEntries(entries);
  return { ok: entries.every(([, c]) => c.ok), checked_at: new Date().toISOString(), checks };
}

module.exports = { deepHealth };
