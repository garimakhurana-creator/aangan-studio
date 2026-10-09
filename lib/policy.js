// Loads the versioned qualification policy (config/policy.json) and answers
// the two lookups the rules engine needs: is a locality in the service area,
// and what is the lowest plausible cost of a described scope.

const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'policy.json');

let cached = null;
function loadPolicy() {
  if (!cached) cached = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
  return cached;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Returns { status: 'in'|'adjoining'|'out'|'unknown', matched }.
// Excluded places are checked first so "Talegaon, near Pune" is out.
function classifyLocality(locality, city, policy = loadPolicy()) {
  const area = policy.service_area;
  const text = norm(`${locality || ''} ${city || ''}`);
  if (!text) return { status: 'unknown', matched: null };

  const hit = list => list.find(name => new RegExp(`\\b${name}\\b`).test(text));
  let m;
  if ((m = hit(area.excluded))) return { status: 'out', matched: m };
  if ((m = hit([...area.pune, ...area.pcmc]))) return { status: 'in', matched: m };
  if ((m = hit(area.adjoining_assumed.localities))) return { status: 'adjoining', matched: m };

  const c = norm(city);
  if (c && !/\b(pune|pimpri|chinchwad|pcmc)\b/.test(c)) return { status: 'out', matched: c };
  if (/\b(pune|pimpri|chinchwad|pcmc)\b/.test(text)) return { status: 'adjoining', matched: 'pune (locality not on list)' };
  return { status: 'unknown', matched: null };
}

// Lowest plausible cost in INR, from the low end of pricing.md. Internal only:
// used to catch a volunteered budget that is clearly too small, never spoken.
function costFloor(project, policy = loadPolicy()) {
  const f = policy.budget.floor_inr;
  const sqft = project.carpet_area_sqft;
  if (project.segment === 'commercial' && sqft) return sqft * f.commercial_per_sqft;
  if (project.scope_type === 'full_home' && sqft) return sqft * f.residential_per_sqft;
  const rooms = project.room_count || (project.rooms || []).length;
  if (rooms) return rooms * f.per_room;
  if (project.scope_type === 'single_room') return f.per_room;
  return null;
}

module.exports = { loadPolicy, classifyLocality, costFloor };
