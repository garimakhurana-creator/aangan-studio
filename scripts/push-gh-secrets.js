// Gives the GitHub uptime monitor (.github/workflows/uptime.yml) the three
// values it needs, copied from .env. Run it yourself:
//   node scripts/push-gh-secrets.js
// Uses the GitHub CLI (gh). Values go straight from .env to GitHub; only the
// names are printed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

let failed = 0;
for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'CRON_SECRET']) {
  if (!env[name]) { console.log(`✗ ${name} is empty in .env`); failed++; continue; }
  const r = spawnSync('gh', ['secret', 'set', name], { cwd: ROOT, input: env[name], encoding: 'utf8', shell: true });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  (${(r.stderr || '').trim().split('\n').pop()})`}`);
}
console.log(failed ? '\nSome failed. Fix the reason shown and run again.' : '\nAll saved. Tell Claude "done" to test the monitor.');
