// Copies the values in .env into this project's Vercel settings (production).
// Run it yourself:  node scripts/push-env.js
// Values go straight from your .env to Vercel; only the names are printed.
//
// Uses `npx vercel` (works even when the vercel command isn't on PATH) and
// always runs in this repo's folder, so it updates the aangan-studio project
// no matter where you start it from.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const vercel = (args, opts = {}) => spawnSync('npx', ['--yes', 'vercel', ...args], { cwd: ROOT, shell: true, encoding: 'utf8', ...opts });

const linked = path.join(ROOT, '.vercel', 'project.json');
if (!fs.existsSync(linked)) { console.log('✗ This folder is not linked to Vercel yet. Run: npx vercel link'); process.exit(1); }
const project = JSON.parse(fs.readFileSync(linked, 'utf8')).projectName;

const who = vercel(['whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (who.status !== 0) { console.log('✗ Vercel is not logged in on this computer. Run: npx vercel login'); process.exit(1); }
console.log(`Updating Vercel project "${project}"…\n`);

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  .filter(([, v]) => v);

let failed = 0;
for (const [key, value] of env) {
  vercel(['env', 'rm', key, 'production', '--yes'], { stdio: 'ignore' });
  const r = vercel(['env', 'add', key, 'production'], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && /Added/.test(out);
  if (!ok) failed++;
  const why = out.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/DeprecationWarning|trace-deprecation|claude-code-hint/.test(s)).slice(-1)[0] || 'unknown error';
  console.log(`${ok ? '✓' : '✗'} ${key}${ok ? '' : `  (${why})`}`);
}
console.log(failed ? `\n${failed} failed. Fix the reason shown and run again.` : '\nAll saved. Tell Claude "done" to redeploy.');
