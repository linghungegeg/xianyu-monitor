CREATE TABLE IF NOT EXISTS supply.publish_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  material_id uuid NOT NULL REFERENCES supply.materials(id),
  material_version_id uuid NOT NULL REFERENCES supply.material_versions(id),
  material_version integer NOT NULL CHECK (material_version >= 1),
  material_snapshot jsonb NOT NULL CHECK (jsonb_typeof(material_snapshot) = 'object'),
  idempotency_key text NOT NULL,
  schedule_mode text NOT NULL CHECK (schedule_mode IN ('immediate', 'scheduled', 'random_window')),
  scheduled_at timestamptz NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  status text NOT NULL CHECK (status IN ('planned', 'claimed', 'publishing', 'published', 'failed', 'paused', 'cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key),
  CHECK (
    (schedule_mode IN ('immediate', 'scheduled') AND window_start IS NULL AND window_end IS NULL)
    OR (schedule_mode = 'random_window' AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_end > window_start AND scheduled_at >= window_start AND scheduled_at <= window_end)
  )
);

CREATE INDEX IF NOT EXISTS idx_supply_publish_plans_user_status_scheduled
  ON supply.publish_plans (user_id, status, scheduled_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_supply_publish_plans_material_version
  ON supply.publish_plans (material_id, material_version, created_at DESC, id DESC);

COMMENT ON TABLE supply.publish_plans IS 'User-owned Xianyu publication plans. The material snapshot is frozen at plan creation and contains no browser/session credentials.';
