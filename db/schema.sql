-- Applied automatically by lib/store.js on first use. Kept here for reference.
-- Each row stores the full record as jsonb; see lib/store.js for the shapes.

CREATE TABLE IF NOT EXISTS aangan_calls  (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS aangan_leads  (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS aangan_events (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
