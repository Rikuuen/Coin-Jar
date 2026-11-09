BEGIN;
ALTER TABLE coinjar_journals ADD COLUMN preferences jsonb NOT NULL DEFAULT '{"bufferCents":20000,"dailyLimitCents":1500,"pace":"steady","currency":"PHP"}'::jsonb;
ALTER TABLE coinjar_journals ADD COLUMN bills jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE coinjar_journals ADD COLUMN wallet_address text;
CREATE TABLE coinjar_entry_voids (
  owner_id text NOT NULL,
  entry_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  replacement_id uuid,
  PRIMARY KEY (owner_id, entry_id),
  FOREIGN KEY (owner_id, entry_id) REFERENCES coinjar_entries(owner_id, id),
  FOREIGN KEY (owner_id, replacement_id) REFERENCES coinjar_entries(owner_id, id)
);
ALTER TABLE coinjar_entry_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_entry_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_entry_voids_owner ON coinjar_entry_voids USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));
COMMIT;
