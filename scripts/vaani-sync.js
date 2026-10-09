// Creates (first run) or updates the Aangan inbound agent in Vaani so its
// instructions, FAQ and settings always match config/policy.json.
//
//   npm run vaani:sync             create or update
//   npm run vaani:sync -- --dry    print what would be sent, change nothing
//
// The agent id is stored in config/vaani-agent.json (not secret). Sections are
// read back from Vaani, modified in place and PATCHed whole, so provider
// fields we don't manage (voices, STT, fallbacks) are preserved.

const fs = require('fs');
const path = require('path');
require('../lib/env').loadDotEnv();
const { loadPolicy } = require('../lib/policy');
const { buildPrompt } = require('../agent/build');

const API = 'https://api.vaanivoice.ai/api';
const ID_FILE = path.join(__dirname, '..', 'config', 'vaani-agent.json');
const dry = process.argv.includes('--dry');

async function vaani(method, route, body) {
  const key = process.env.VAANI_API_KEY;
  if (!key) throw new Error('VAANI_API_KEY is not set in .env');
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Vaani ${method} ${route} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Short verbatim answers for the questions callers ask most. Every answer is
// an approved line or a fact from kb/faq.md.
function faq(policy) {
  const L = policy.approved_lines;
  return {
    'How much will it cost? What is your per square foot rate? Can you give a ballpark or range?': L.pricing,
    'Can you email me your price list?': L.pricing,
    'Is the consultation free?': 'Yes, the consultation is free and there is no obligation.',
    'Can someone just come and give us ideas or advice?': L.decline_advice_only,
    'Do you work outside Pune, like Talegaon, Lonavala, Nashik or Mumbai?': L.decline_area,
    'Do you design restaurants, cafes, hotels, shops or gyms?': L.decline_segment,
    'Can you do my flat if I am renting?': 'Yes, rented homes are fine as long as there are no structural changes. Kitchens can be modular units that come out cleanly.',
    'Can you break or move walls?': 'We are interior designers, not architects, so we do not move or break walls or change the structure. We can design everything else.',
    'How long does a project take?': 'Design takes three to four weeks from the first consultation, and execution takes roughly eight to sixteen weeks depending on size and how ready the site is. Your designer will give you a plan for your project.',
    'Can you finish it in a few weeks?': 'We can\'t take on a project that needs to be finished in under six weeks — the design phase alone takes three to four weeks.',
    'Do you do Vastu?': 'We incorporate Vastu requirements into our designs, but we don\'t offer Vastu consultation on its own.',
    'Which designer will I get?': 'The studio assigns the designer for each project, and you\'ll meet them at the consultation.',
    'Where can I see your work?': 'Our portfolio is on our website and Instagram.',
    'Am I talking to a real person?': `I'm ${policy.agent.name}, Aangan Studio's virtual assistant.`,
  };
}

function applyConfig(agent, policy) {
  const prompt = buildPrompt(policy);
  const p = agent.persona || {};

  p.identity = p.identity || {};
  p.identity.system_prompt = prompt;
  p.identity.greeting_message = {
    ...(p.identity.greeting_message || {}),
    agent_message: policy.agent.greeting,
    interruptible: true,
    let_user_speak_first: false,
    agent_speech_delay: 1,
    user_speech_delay: 0,
  };
  p.agent_gender = 'female';
  p.timezone = 'Asia/Kolkata';

  // Low temperature: this agent should follow its script, not improvise.
  const sc = p.senses_capabilities = p.senses_capabilities || {};
  sc.auto_detect = true; // English / Hindi / Marathi callers
  sc.brain = sc.brain || {};
  sc.brain.llm = {
    ...(sc.brain.llm || {}),
    primary: { provider: 'google', model: process.env.VAANI_LLM_MODEL || 'gemini-3.5-flash', parameters: { temperature: 0.2, top_p: 0.9, max_tokens: 400 } },
    auto_detect: false,
  };
  if (sc.brain.llm.fallback?.parameters) sc.brain.llm.fallback.parameters.temperature = 0.2;

  // Lets the agent see earlier calls from the same number (repeat callers, T16).
  p.memories = { ...(p.memories || {}), use_previous_call_contexts: true, max_history_calls: 5 };
  agent.persona = p;

  const t = agent.training = agent.training || {};
  t.know_how = {
    ...(t.know_how || {}),
    faq: faq(policy),
    guardrails: { ...(t.know_how?.guardrails || {}), level: 'strict', sexual: true, violence: true, threatning: true },
  };

  const e = agent.experience = agent.experience || {};
  e.settings = e.settings || {};
  e.settings.idle_conversation_settings = {
    ...(e.settings.idle_conversation_settings || {}),
    idle_call_warning_message: 'Are you still there? Take your time.',
    idle_call_hangup_message: 'It seems we got disconnected. Please call Aangan Studio back anytime — we answer day and night. Goodbye.',
    initial_warning_message: 'Hello, can you hear me?',
  };

  // Vaani's own post-call extraction, kept as a backup to ours.
  const a = agent.analysis = agent.analysis || {};
  a.extraction = a.extraction || {};
  a.extraction.data_collection = {
    enabled: true,
    data_points: [
      { name: 'caller_email', prompt: 'The email address the caller gave, exactly as confirmed. Empty if none.', nullable: true, choices: null },
      { name: 'preferred_times', prompt: 'Days or times the caller said suit them for the consultation, in their words.', nullable: true, choices: null },
      { name: 'site_visit', prompt: 'Did the caller want the consultation at their site rather than the studio? yes or no.', nullable: true, choices: ['yes', 'no'] },
    ],
  };
  return agent;
}

async function main() {
  const policy = loadPolicy();
  let saved = fs.existsSync(ID_FILE) ? JSON.parse(fs.readFileSync(ID_FILE, 'utf-8')) : null;
  const displayName = `Aangan Studio – ${policy.agent.name}`;

  if (!saved) {
    if (dry) { console.log(`[dry] would create agent "${displayName}"`); return; }
    const created = await vaani('POST', '/create-agent', {
      agent_display_name: displayName,
      config: { deployment_config: { ideal_deployment: 'Inbound' } },
    });
    const id = created.agent_id || created.id;
    if (!id) throw new Error(`Create returned no agent_id: ${JSON.stringify(created).slice(0, 300)}`);
    saved = { agent_id: id, display_name: displayName, created_at: new Date().toISOString() };
    fs.writeFileSync(ID_FILE, JSON.stringify(saved, null, 2) + '\n');
    console.log(`Created agent ${id}`);
  }

  // Nothing reaches Vaani that the guardrail would flag on a live call.
  const { factCheck } = require('../lib/factcheck');
  const bad = Object.entries(faq(policy)).filter(([, a]) => !factCheck([{ speaker: 'agent', text: a }]).ok);
  if (bad.length) throw new Error(`FAQ answers fail the fact-check: ${bad.map(([q]) => q).join(' | ')}`);

  const current = await vaani('GET', `/agent/${saved.agent_id}`);
  const next = applyConfig(structuredClone(current), policy);
  if (dry) {
    console.log(JSON.stringify({ persona: next.persona.identity.greeting_message, llm: next.persona.senses_capabilities.brain.llm, faq_count: Object.keys(next.training.know_how.faq).length }, null, 2));
    return;
  }
  await vaani('PATCH', `/agent/${saved.agent_id}/persona`, next.persona);
  await vaani('PATCH', `/agent/${saved.agent_id}/training`, next.training);
  await vaani('PATCH', `/agent/${saved.agent_id}/experience`, next.experience);
  await vaani('PATCH', `/agent/${saved.agent_id}/analysis`, next.analysis);

  // Read back and verify what Vaani stored.
  const after = await vaani('GET', `/agent/${saved.agent_id}`);
  const checks = {
    prompt_matches: after.persona?.identity?.system_prompt === next.persona.identity.system_prompt,
    greeting: after.persona?.identity?.greeting_message?.agent_message,
    llm: after.persona?.senses_capabilities?.brain?.llm?.primary,
    memory: after.persona?.memories?.use_previous_call_contexts,
    faq_entries: Object.keys(after.training?.know_how?.faq || {}).length,
    guardrails: after.training?.know_how?.guardrails?.level,
  };
  console.log(JSON.stringify(checks, null, 2));
  saved.synced_at = new Date().toISOString();
  saved.policy_version = policy.version;
  fs.writeFileSync(ID_FILE, JSON.stringify(saved, null, 2) + '\n');
  if (!checks.prompt_matches) { console.error('Prompt on Vaani does not match the generated prompt.'); process.exitCode = 1; }
}

main().catch(err => { console.error(err.message); process.exit(1); });
