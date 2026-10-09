// Copies the values in .env into the linked Vercel project (production).
// Run it yourself after `vercel link`:  node scripts/push-env.js
// Values go straight from your .env to Vercel; nothing is printed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  .filter(([, v]) => v);

const skip = new Set(['EMAIL_OVERRIDE_TO_LOCAL_ONLY']);
for (const [key, value] of env) {
  if (skip.has(key)) continue;
  spawnSync('vercel', ['env', 'rm', key, 'production', '--yes'], { shell: true, stdio: 'ignore' });
  const r = spawnSync('vercel', ['env', 'add', key, 'production'], { shell: true, input: value, stdio: ['pipe', 'ignore', 'pipe'] });
  console.log(`${r.status === 0 ? '✓' : '✗'} ${key}${r.status === 0 ? '' : `  ${String(r.stderr).trim().split('\n').pop()}`}`);
}
console.log('\nDone. Redeploy for the values to take effect: vercel deploy --prod');
