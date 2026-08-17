CREATE TABLE IF NOT EXISTS ops.monitor_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  kind text NOT NULL CHECK (kind IN ('search')),
  rule_json jsonb NOT NULL CHECK (jsonb_typeof(rule_json) = 'object'),
  rule_version integer NOT NULL CHECK (rule_version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  active_slot smallint CHECK (active_slot BETWEEN 1 AND 20),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 86400),
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((status = 'active' AND active_slot IS NOT NULL) OR (status = 'paused' AND active_slot IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_monitor_tasks_user_status_next_run
  ON ops.monitor_tasks (user_id, status, next_run_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_tasks_active_slot
  ON ops.monitor_tasks (user_id, active_slot)
  WHERE status = 'active';
