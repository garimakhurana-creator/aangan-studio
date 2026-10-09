// Prints the Vaani webhook address for this deployment and checks it works.
// Run it yourself:  node scripts/webhook-url.js
// The address contains VAANI_WEBHOOK_SECRET, so it is printed only in your
// own terminal, for you to paste into Vaani (Settings → Webhooks).

require('../lib/env').loadDotEnv();

const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const secret = process.env.VAANI_WEBHOOK_SECRET;
if (!base || !secret) {
  console.log('✗ PUBLIC_BASE_URL and VAANI_WEBHOOK_SECRET must both be set in .env');
  process.exit(1);
}
const url = `${base}/api/vaani/webhook?key=${secret}`;

(async () => {
  const post = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.status).catch(() => 0);
  const wrong = await post(`${base}/api/vaani/webhook?key=wrong`, { event: 'call_started', room_name: 'check-wrong-key' });
  const right = await post(url, { event: 'call_started', room_name: `webhook-check-${Date.now()}` });
  console.log(`${wrong === 401 ? '✓' : '✗'} Rejects a wrong key (got ${wrong})`);
  console.log(`${right === 200 ? '✓' : '✗'} Accepts the right key (got ${right})`);
  console.log('\nPaste this into Vaani → Settings → Webhooks:\n');
  console.log(`  ${url}\n`);
  console.log('Tick the events: call_started, call_ended and call_postprocessing.');
})();
