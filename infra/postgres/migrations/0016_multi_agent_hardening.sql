ALTER TABLE ai.jobs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_ai_jobs_worker_claim
  ON ai.jobs (status, lease_expires_at, created_at, id);
