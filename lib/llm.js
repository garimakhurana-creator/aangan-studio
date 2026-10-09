// Gemini structured-output client.
// Every call returns zod-validated JSON plus token usage, so the cost ledger
// can price each call.

const { z } = require('zod');

const TIMEOUT_MS = 2 * 60 * 1000;
const ATTEMPTS = 4; // waits 3s, 9s, 27s between tries
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const model = () => process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const isConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

// zod -> JSON Schema, minus the keys Gemini's responseJsonSchema doesn't need.
function geminiSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  return JSON.parse(JSON.stringify(json), (key, value) =>
    (key === 'minimum' || key === 'maximum') && Math.abs(value) === Number.MAX_SAFE_INTEGER ? undefined : value);
}

async function callStructured({ system, user, schema, thinking = 'low' }) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY is not set. Add it to .env.');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: 8000,
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: geminiSchema(schema),
      thinkingConfig: { thinkingLevel: thinking },
    },
  });

  let res, data;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      data = await res.json().catch(() => ({}));
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= ATTEMPTS) break;
    } catch (err) {
      if (attempt >= ATTEMPTS || err.name === 'TimeoutError') throw new Error(`Gemini request failed: ${err.cause?.code || err.message}`);
    }
    await new Promise(r => setTimeout(r, 3000 * 3 ** (attempt - 1)));
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || 'request failed'}`);

  const candidate = (data.candidates || [])[0];
  if (!candidate) throw new Error(`Gemini returned no answer${data.promptFeedback?.blockReason ? ` (blocked: ${data.promptFeedback.blockReason})` : ''}.`);
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw new Error(`Gemini stopped early: ${candidate.finishReason}.`);

  const text = (candidate.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini returned invalid JSON.'); }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Gemini output did not match the schema: ${result.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  const u = data.usageMetadata || {};
  return {
    data: result.data,
    usage: {
      model: model(),
      input_tokens: u.promptTokenCount || 0,
      output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    },
  };
}

// Plain multi-turn text reply (used to simulate the voice agent in evals).
// messages: [{ role: 'user'|'model', text }]
async function callChat({ system, messages, temperature = 0.7 }) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY is not set. Add it to .env.');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig: { maxOutputTokens: 4000, temperature, thinkingConfig: { thinkingLevel: 'low' } },
  });
  let res, data;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(err => ({ ok: false, status: 0, json: async () => ({ error: { message: err.message } }) }));
    data = await res.json().catch(() => ({}));
    if (res.ok || !(res.status === 0 || RETRYABLE_STATUS.has(res.status)) || attempt >= ATTEMPTS) break;
    await new Promise(r => setTimeout(r, 3000 * 3 ** (attempt - 1)));
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || 'request failed'}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
}

module.exports = { callStructured, callChat, isConfigured, model };
