CREATE TABLE IF NOT EXISTS ops.seller_monitor_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  seller_id uuid NOT NULL REFERENCES market.seller_profiles(id),
  profile_url text NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  active_slot smallint CHECK (active_slot BETWEEN 1 AND 5),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 86400),
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, seller_id),
  CHECK ((status = 'active' AND active_slot IS NOT NULL) OR (status = 'paused' AND active_slot IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_seller_monitor_tasks_user_status_next_run
  ON ops.seller_monitor_tasks (user_id, status, next_run_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_monitor_tasks_active_slot
  ON ops.seller_monitor_tasks (user_id, active_slot)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ops.task_event_links (
  task_id uuid NOT NULL REFERENCES ops.seller_monitor_tasks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  matched_at timestamptz NOT NULL,
  rule_version integer NOT NULL CHECK (rule_version >= 1),
  PRIMARY KEY (task_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_task_event_links_event_task
  ON ops.task_event_links (event_id, task_id);
