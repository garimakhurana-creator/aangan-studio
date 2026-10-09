// Grounds Gemini's extraction in the transcript before anything reaches a
// designer, the CRM or the rules engine. A fact the caller never said is
// removed (set to null / dropped) and logged as a warning, so an invented
// name, locality, area, budget or quote can't flow downstream.

const norm = s => String(s || '').toLowerCase()
  .replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-')
  .replace(/[^a-z0-9ऀ-ॿ'\s]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'near', 'area', 'road', 'pune', 'city', 'east', 'west', 'phase', 'sector', 'i', 'my', 'we', 'it', 'is', 'to']);

function verifyExtraction(extraction, transcript) {
  const x = structuredClone(extraction);
  const warnings = [];
  const callerText = norm(String(transcript).split('\n').filter(l => !/^(front desk|agent|meera)\s*:/i.test(l)).join(' '));
  const all = norm(transcript);
  const has = word => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(all);
  const numbers = new Set([...String(transcript).matchAll(/\d[\d,]*(\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, ''))));

  // Evidence quotes: keep if verbatim, or nearly so (speech-to-text noise).
  x.evidence = (x.evidence || []).filter(e => {
    const q = norm(e.quote);
    if (!q) return false;
    if (callerText.includes(q) || all.includes(q)) return true;
    const words = q.split(' ').filter(w => w.length > 2);
    const found = words.filter(w => has(w)).length;
    if (words.length && found / words.length >= 0.85) return true;
    warnings.push(`Dropped evidence quote not found in transcript: "${e.quote}"`);
    return false;
  });

  const requireWords = (value, label) => {
    if (!value) return value;
    const words = norm(value).split(' ').filter(w => w.length > 2 && !STOP.has(w));
    if (!words.length || words.some(w => has(w))) return value;
    warnings.push(`Removed ${label} "${value}": not said on the call.`);
    return null;
  };

  x.caller_name = requireWords(x.caller_name, 'caller name');
  if (x.referral) x.referral.referrer_name = requireWords(x.referral.referrer_name, 'referrer name');
  if (x.referral?.knows_founder && !has('nikhil')) {
    x.referral.knows_founder = false;
    warnings.push('Cleared "knows the founder": Nikhil was not mentioned.');
  }
  if (x.project) {
    x.project.locality = requireWords(x.project.locality, 'locality');
    x.project.city = requireWords(x.project.city, 'city');
    const area = x.project.carpet_area_sqft;
    if (area != null && !numbers.has(area)) {
      warnings.push(`Removed carpet area ${area}: that number was not said.`);
      x.project.carpet_area_sqft = null;
    }
  }
  if (x.budget?.volunteered) {
    const said = [...String(x.budget.text || '').matchAll(/\d[\d,]*(\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, '')));
    if (!said.length || !said.some(n => numbers.has(n))) {
      warnings.push(`Removed volunteered budget "${x.budget.text}": no matching figure on the call.`);
      x.budget = { volunteered: false, max_inr: null, text: null };
    }
  }
  if (x.complaint) x.complaint.designer_named = requireWords(x.complaint.designer_named, 'designer name');

  return { extraction: x, warnings };
}

module.exports = { verifyExtraction };
