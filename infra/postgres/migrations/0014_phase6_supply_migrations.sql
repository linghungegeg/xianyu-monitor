CREATE TABLE IF NOT EXISTS supply.migration_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('market_item', 'published_item', 'public_url')),
  source_reference text,
  platform text NOT NULL CHECK (platform = 'goofish'),
  platform_item_id text NOT NULL,
  item_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed')),
  claimed_by_client_id uuid REFERENCES identity.collector_clients(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  material_id uuid REFERENCES supply.materials(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_supply_migration_requests_claim
  ON supply.migration_requests (user_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_supply_migration_requests_item
  ON supply.migration_requests (user_id, platform, platform_item_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS supply.migration_attempts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES supply.migration_requests(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  attempt_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  safe_error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  UNIQUE (client_id, attempt_key)
);
CREATE INDEX IF NOT EXISTS idx_supply_migration_attempts_request
  ON supply.migration_attempts (request_id, created_at DESC, id DESC);

COMMENT ON TABLE supply.migration_requests IS 'Public goofish identifiers only. The bound local Electron Chrome reads public details; cookies, tokens and browser profiles are never accepted.';
