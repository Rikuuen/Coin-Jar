BEGIN;
CREATE TABLE coinjar_memory_sync (
  owner_id text NOT NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown', 'stored')),
  remote_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation_id)
);
ALTER TABLE coinjar_memory_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_memory_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_memory_sync_owner ON coinjar_memory_sync USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));
COMMIT;
