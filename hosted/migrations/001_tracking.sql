BEGIN;

CREATE TABLE coinjar_journals (
  owner_id text PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 255),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coinjar_entries (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES coinjar_journals(owner_id),
  kind text NOT NULL CHECK (kind IN ('income', 'expense', 'recorded_saving')),
  amount_centavos bigint NOT NULL CHECK (amount_centavos > 0 AND amount_centavos <= 10000000000),
  entry_date date NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);

CREATE INDEX coinjar_entries_owner_date ON coinjar_entries(owner_id, entry_date DESC, created_at DESC);

CREATE TABLE coinjar_goals (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES coinjar_journals(owner_id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  target_centavos bigint NOT NULL CHECK (target_centavos > 0 AND target_centavos <= 10000000000),
  target_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coinjar_operations (
  owner_id text NOT NULL REFERENCES coinjar_journals(owner_id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation_id)
);

COMMIT;
