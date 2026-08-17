ALTER TABLE identity.collector_clients
  ADD COLUMN IF NOT EXISTS device_public_key text,
  ADD COLUMN IF NOT EXISTS key_algorithm text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'collector_clients_key_algorithm_check'
      AND connamespace = 'identity'::regnamespace
  ) THEN
    ALTER TABLE identity.collector_clients
      ADD CONSTRAINT collector_clients_key_algorithm_check
      CHECK (key_algorithm IS NULL OR key_algorithm IN ('ed25519'));
  END IF;
END $$;

ALTER TABLE identity.auth_refresh_sessions
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS rotated_from_id uuid,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS replay_detected_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_family ON identity.auth_refresh_sessions (family_id, revoked_at, expires_at DESC, id DESC);

ALTER TABLE billing.entitlement_grants
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id uuid;
CREATE INDEX IF NOT EXISTS idx_entitlements_source ON billing.entitlement_grants (source_type, source_id);

ALTER TABLE billing.usage_ledger
  ADD COLUMN IF NOT EXISTS subject_type text,
  ADD COLUMN IF NOT EXISTS subject_id uuid;

CREATE TABLE IF NOT EXISTS billing.plan_capabilities (
  plan_id uuid NOT NULL REFERENCES billing.plans(id),
  capability text NOT NULL,
  limit_value integer NOT NULL CHECK (limit_value >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (plan_id, capability)
);

CREATE TABLE IF NOT EXISTS billing.payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  status text NOT NULL CHECK (status IN ('received', 'processed', 'rejected')),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON billing.payment_events (status, received_at DESC, id DESC);

ALTER TABLE ops.audit_logs
  ADD COLUMN IF NOT EXISTS request_id_hash text;
