CREATE TABLE IF NOT EXISTS supply.publish_attempts (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES supply.publish_plans(id),
  user_id uuid NOT NULL REFERENCES identity.users(id),
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  claim_batch_id uuid NOT NULL REFERENCES supply.publish_claim_batches(id),
  attempt_key text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  status text NOT NULL CHECK (status IN ('needs_attention','succeeded','failed')),
  error_code text,
  error_message text,
  xianyu_item_id text,
  xianyu_url text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (client_id, attempt_key)
);
CREATE INDEX IF NOT EXISTS idx_supply_publish_attempts_user_recent
  ON supply.publish_attempts (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_supply_publish_attempts_plan_recent
  ON supply.publish_attempts (plan_id, created_at DESC, id DESC);
ALTER TABLE supply.publish_plans
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS xianyu_item_id text,
  ADD COLUMN IF NOT EXISTS xianyu_url text;
