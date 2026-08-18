CREATE TABLE IF NOT EXISTS billing.user_points (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ops.announcements (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'personal')),
  user_id uuid REFERENCES identity.users(id),
  enabled boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by uuid REFERENCES identity.admin_users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((scope = 'global' AND user_id IS NULL) OR (scope = 'personal' AND user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON ops.announcements (enabled, starts_at DESC, ends_at, id DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_user_active ON ops.announcements (user_id, enabled, starts_at DESC, ends_at, id DESC);

ALTER TABLE ai.jobs
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'personal';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_jobs_scope_check' AND connamespace = 'ai'::regnamespace
  ) THEN
    ALTER TABLE ai.jobs ADD CONSTRAINT ai_jobs_scope_check CHECK (scope IN ('global', 'personal'));
  END IF;
END $$;

ALTER TABLE ai.provider_configs
  ADD COLUMN IF NOT EXISTS base_url text,
  ADD COLUMN IF NOT EXISTS stream_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reasoning_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_key_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_provider_configs_status_updated ON ai.provider_configs (status, updated_at DESC, id DESC);
