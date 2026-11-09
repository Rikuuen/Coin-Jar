BEGIN;

ALTER TABLE coinjar_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_journals FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_journals_owner ON coinjar_journals USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));

ALTER TABLE coinjar_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_entries_owner ON coinjar_entries USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));

ALTER TABLE coinjar_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_goals_owner ON coinjar_goals USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));

ALTER TABLE coinjar_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE coinjar_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY coinjar_operations_owner ON coinjar_operations USING (owner_id = nullif(current_setting('coinjar.owner', true), '')) WITH CHECK (owner_id = nullif(current_setting('coinjar.owner', true), ''));

COMMIT;
