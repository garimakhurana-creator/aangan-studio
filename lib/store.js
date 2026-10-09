// Canonical record of every call, lead and action. Neon Postgres when
// DATABASE_URL is set (tables created on first use, see db/schema.sql),
// otherwise a local JSON file at data/store.json for offline demos.
//
// Three collections, each row = { id, data jsonb }:
//   calls   one per Vaani call (transcript, phone, duration, cost)
//   leads   one per enquiry; a dropped call and its callback share a lead
//   events  every external action and decision, keyed for idempotency
// At ~200 enquiries a month, filtering in JS is simpler than many columns.

const fs = require('fs');
const path = require('path');

// Vercel's filesystem is read-only except /tmp, which is per-instance and can reset.
const FILE = process.env.VERCEL ? path.join('/tmp', 'aangan-store.json') : path.join(__dirname, '..', 'data', 'store.json');
const COLLECTIONS = ['calls', 'leads', 'events'];

function localBackend() {
  const read = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf-8')) : { calls: {}, leads: {}, events: {} });
  const write = db => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db, null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
  };
  return {
    name: process.env.VERCEL ? 'temporary' : 'local',
    async get(col, id) { return read()[col][id] || null; },
    async put(col, id, data) { const db = read(); db[col][id] = data; write(db); return data; },
    async insertIfAbsent(col, id, data) {
      const db = read();
      if (db[col][id]) return false;
      db[col][id] = data; write(db); return true;
    },
    async all(col) { return Object.values(read()[col]); },
    async remove(col, id) { const db = read(); delete db[col][id]; write(db); },
    async clear() { write({ calls: {}, leads: {}, events: {} }); },
  };
}

function neonBackend(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  let ready = null;
  const init = () => (ready ||= Promise.all(COLLECTIONS.map(c => sql.query(
    `CREATE TABLE IF NOT EXISTS aangan_${c} (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`))));
  const table = col => {
    if (!COLLECTIONS.includes(col)) throw new Error(`Unknown collection ${col}`);
    return `aangan_${col}`;
  };
  return {
    name: 'neon',
    async get(col, id) {
      await init();
      const rows = await sql.query(`SELECT data FROM ${table(col)} WHERE id = $1`, [id]);
      return rows[0]?.data || null;
    },
    async put(col, id, data) {
      await init();
      await sql.query(`INSERT INTO ${table(col)} (id, data) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [id, JSON.stringify(data)]);
      return data;
    },
    // Atomic: used to claim an idempotency key exactly once.
    async insertIfAbsent(col, id, data) {
      await init();
      const rows = await sql.query(`INSERT INTO ${table(col)} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`, [id, JSON.stringify(data)]);
      return rows.length > 0;
    },
    async all(col) {
      await init();
      const rows = await sql.query(`SELECT data FROM ${table(col)} ORDER BY updated_at DESC`);
      return rows.map(r => r.data);
    },
    async remove(col, id) {
      await init();
      await sql.query(`DELETE FROM ${table(col)} WHERE id = $1`, [id]);
    },
    async clear() {
      await init();
      for (const c of COLLECTIONS) await sql.query(`DELETE FROM ${table(c)}`);
    },
  };
}

let backend = null;
function store() {
  if (!backend) backend = process.env.DATABASE_URL ? neonBackend(process.env.DATABASE_URL) : localBackend();
  return backend;
}

// For tests: swap in an in-memory backend.
function useMemoryStore() {
  const db = { calls: {}, leads: {}, events: {} };
  backend = {
    name: 'memory',
    async get(c, id) { return db[c][id] ? structuredClone(db[c][id]) : null; },
    async put(c, id, d) { db[c][id] = structuredClone(d); return d; },
    async insertIfAbsent(c, id, d) { if (db[c][id]) return false; db[c][id] = structuredClone(d); return true; },
    async all(c) { return Object.values(db[c]).map(x => structuredClone(x)); },
    async remove(c, id) { delete db[c][id]; },
    async clear() { for (const c of COLLECTIONS) db[c] = {}; },
  };
  return backend;
}

module.exports = { store, useMemoryStore };
