CREATE TABLE IF NOT EXISTS supply.publish_claim_batches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  idempotency_key text NOT NULL,
  requested_limit integer NOT NULL CHECK (requested_limit BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  created_at timestamptz NOT NULL,
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_supply_publish_claim_batches_client_recent
  ON supply.publish_claim_batches (client_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS supply.publish_plan_claims (
  id uuid PRIMARY KEY,
  claim_batch_id uuid NOT NULL REFERENCES supply.publish_claim_batches(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES supply.publish_plans(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  claimed_at timestamptz NOT NULL,
  UNIQUE (claim_batch_id, plan_id),
  UNIQUE (plan_id)
);

CREATE INDEX IF NOT EXISTS idx_supply_publish_plan_claims_client_recent
  ON supply.publish_plan_claims (client_id, claimed_at DESC, plan_id);

ALTER TABLE supply.publish_plans
  ADD COLUMN IF NOT EXISTS claimed_by_client_id uuid REFERENCES identity.collector_clients(id),
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_supply_publish_plans_due_claim
  ON supply.publish_plans (user_id, status, scheduled_at ASC, id ASC)
  WHERE status = 'planned';

COMMENT ON TABLE supply.publish_claim_batches IS 'Collector-side idempotent claim requests. It contains device identifiers and no browser/session state.';
COMMENT ON TABLE supply.publish_plan_claims IS 'Frozen plan delivery receipts only. Publishing outcome, retries, and browser state are deliberately outside Phase 3.';
