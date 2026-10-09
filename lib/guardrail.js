// Pricing guardrail. pricing.md: the agent must never say "any specific
// number, range, or per-sq-ft figure". Every line the AI speaks to a caller
// (or writes to one) is scanned here. Echoing a caller's own area ("1,400 sq
// ft") is fine; any money figure or rate is not.

const MONEY_WORD = /(₹|\brs\.?\b|\binr\b|\brupees?\b|\blakhs?\b|\blacs?\b|\blakh\b|\bcrores?\b|\bcr\b|\bthousand\b|\bhazaar\b|\bहज़ार\b|\bहजार\b|लाख|करोड़|रुपये|रुपए)/i;
const NUMBER = /(\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty|hundred|ek|do|teen|char|paanch|das|bees|pachas)\b)/i;
const RATE = /\bper\s*(sq|square)|\/\s*sq\s*\.?\s*f|\bpsf\b|प्रति\s*(वर्ग|स्क्वेयर)/i;
const PHRASES = [
  /\bit('|’)?ll cost around\b/i,
  /\b(our )?rates? (start|begin)/i,
  /\bstarts? (at|from)\b.*\d/i,
  /\btypically (costs?|comes? to|runs?)\b/i,
  /\bballpark (is|would be|of)\b/i,
  /\bfor a \dbhk it('|’)?s\b/i,
];

// Returns [] when clean, else a list of reasons.
function pricingViolations(text) {
  const t = String(text || '');
  const reasons = [];
  // Money word within ~25 chars of a number, either order.
  const re = new RegExp(`(${NUMBER.source}).{0,25}?(${MONEY_WORD.source})|(${MONEY_WORD.source}).{0,25}?(${NUMBER.source})`, 'i');
  if (re.test(t)) reasons.push('money figure');
  if (RATE.test(t) && NUMBER.test(t.match(new RegExp(`.{0,30}(${RATE.source}).{0,30}`, 'i'))?.[0] || '')) reasons.push('per-sq-ft rate');
  for (const p of PHRASES) if (p.test(t)) reasons.push(`banned phrase: ${p.source}`);
  return reasons;
}

module.exports = { pricingViolations };
