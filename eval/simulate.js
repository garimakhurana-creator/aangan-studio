// Replays the 20 phone transcripts through extraction + rules engine and
// scores them against eval/golden.json.
//
//   npm run eval            extract with Gemini (cached per transcript+schema), then score
//   npm run eval -- --fresh ignore the cache and re-extract everything
//   npm run eval:offline    score from the cache only (no API calls)
//
// Writes eval/results.json and eval/report.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('../lib/env').loadDotEnv();
const { extractCall, ExtractionSchema } = require('../lib/extract');
const { qualify } = require('../lib/qualify');
const { verifyExtraction } = require('../lib/verify-extraction');
const { loadPolicy } = require('../lib/policy');
const { z } = require('zod');

const DIR = __dirname;
const TRANSCRIPTS = path.join(DIR, 'transcripts');
const CACHE = path.join(DIR, 'cache');
const golden = JSON.parse(fs.readFileSync(path.join(DIR, 'golden.json'), 'utf-8')).cases;
const fresh = process.argv.includes('--fresh');
const offline = process.argv.includes('--offline');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function callDate(header) {
  const m = header.match(/(\d{1,2}) (\w+)/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : `2026-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Cache key changes when the transcript or the extraction schema changes.
const schemaHash = crypto.createHash('sha1').update(JSON.stringify(z.toJSONSchema(ExtractionSchema))).digest('hex').slice(0, 8);
const keyFor = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 8) + '-' + schemaHash;

async function getExtraction(id, transcript) {
  const file = path.join(CACHE, `${id}.json`);
  const key = keyFor(transcript);
  if (!fresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (cached.key === key || offline) return { ...cached, from_cache: true };
  }
  if (offline) throw new Error(`No cached extraction for ${id}. Run npm run eval first.`);
  const header = transcript.split('\n')[0];
  const started = Date.now();
  const { extraction, usage } = await extractCall({ transcript, callDate: callDate(header) });
  const record = { key, call_date: callDate(header), latency_ms: Date.now() - started, usage, extraction };
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

function score(id, decision) {
  const g = golden[id];
  const problems = [];
  if (decision.route !== g.route) problems.push(`route ${decision.route} ≠ expected ${g.route}`);
  if (g.reason && !decision.reason_codes.includes(g.reason)) problems.push(`missing reason ${g.reason} (got ${decision.reason_codes.join(', ') || 'none'})`);
  for (const f of g.flags || []) if (!decision.flags.includes(f)) problems.push(`missing flag ${f}`);
  return problems;
}

async function main() {
  const ids = fs.readdirSync(TRANSCRIPTS).filter(f => f.endsWith('.txt')).map(f => f.replace('.txt', '')).sort();
  const policy = loadPolicy();
  const results = [];
  for (const id of ids) {
    const transcript = fs.readFileSync(path.join(TRANSCRIPTS, `${id}.txt`), 'utf-8');
    try {
      const rec = await getExtraction(id, transcript);
      const { extraction, warnings } = verifyExtraction(rec.extraction, transcript);
      const decision = qualify(extraction, policy);
      const problems = score(id, decision);
      results.push({ id, pass: problems.length === 0, problems, grounding_warnings: warnings, expected: golden[id], decision, extraction, usage: rec.usage, latency_ms: rec.latency_ms, from_cache: !!rec.from_cache });
      console.log(`${problems.length ? '✗' : '✓'} ${id}  ${decision.route.padEnd(15)} ${problems.join('; ')}${warnings.length ? `  [grounding: ${warnings.join(' | ')}]` : ''}`);
    } catch (err) {
      results.push({ id, pass: false, problems: [err.message], expected: golden[id] });
      console.log(`✗ ${id}  ERROR ${err.message}`);
    }
  }

  const passed = results.filter(r => r.pass).length;
  const tokens = results.reduce((a, r) => ({ in: a.in + (r.usage?.input_tokens || 0), out: a.out + (r.usage?.output_tokens || 0) }), { in: 0, out: 0 });
  const summary = {
    run_at: new Date().toISOString(),
    policy_version: policy.version,
    model: results.find(r => r.usage)?.usage.model || null,
    passed, total: results.length,
    grounding_warnings: results.reduce((n, r) => n + (r.grounding_warnings?.length || 0), 0),
    tokens,
  };
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ summary, results }, null, 2));
  fs.writeFileSync(path.join(DIR, 'report.md'), report(summary, results));
  console.log(`\n${passed}/${results.length} transcripts match the expected outcome (policy ${policy.version}).`);
  if (passed !== results.length) process.exitCode = 1;
}

function report(s, results) {
  const rows = results.map(r => `| ${r.id} | ${r.expected?.route || ''} | ${r.decision?.route || 'error'} | ${r.pass ? '✅' : '❌ ' + r.problems.join('; ')} | ${(r.decision?.flags || []).join(', ')} |`).join('\n');
  return `# Eval report

Run ${s.run_at} · policy \`${s.policy_version}\` · model \`${s.model}\`

**${s.passed}/${s.total}** phone transcripts routed as expected. Grounding check removed ${s.grounding_warnings} unsupported extracted facts.
Tokens (all extractions): ${s.tokens.in} in / ${s.tokens.out} out.

| Call | Expected | Got | Result | Flags |
|---|---|---|---|---|
${rows}
`;
}

main().catch(err => { console.error(err); process.exit(1); });
