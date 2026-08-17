CREATE TABLE IF NOT EXISTS ai.job_idempotency (
  requesting_user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (requesting_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ai.provider_configs (
  id uuid PRIMARY KEY,
  provider_code text NOT NULL UNIQUE,
  model_reference text NOT NULL,
  api_key_ciphertext text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE ai.jobs
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cost_quantity integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_ai_job_idempotency_job ON ai.job_idempotency (job_id);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_failure_time ON ai.jobs (status, finished_at DESC, id DESC) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_ai_insights_job_time ON ai.insights (ai_job_id, created_at DESC, id DESC);
