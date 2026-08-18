CREATE TABLE IF NOT EXISTS ops.published_item_monitor_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  publish_plan_id uuid REFERENCES supply.publish_plans(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform = 'goofish'),
  platform_item_id text NOT NULL,
  item_url text NOT NULL,
  rule_version integer NOT NULL DEFAULT 1 CHECK (rule_version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 1800 AND 86400),
  next_run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, platform, platform_item_id)
);

ALTER TABLE ops.published_item_monitor_tasks
  ADD COLUMN IF NOT EXISTS rule_version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_published_item_monitor_tasks_user_status_next_run
  ON ops.published_item_monitor_tasks (user_id, status, next_run_at, id);

CREATE INDEX IF NOT EXISTS idx_published_item_monitor_tasks_plan
  ON ops.published_item_monitor_tasks (publish_plan_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_published_item_monitor_tasks_item
  ON ops.published_item_monitor_tasks (platform, platform_item_id, updated_at DESC, id DESC);

COMMENT ON TABLE ops.published_item_monitor_tasks IS 'Phase 5 user-owned goofish published item monitoring targets; only public item identifiers and URLs are stored.';
