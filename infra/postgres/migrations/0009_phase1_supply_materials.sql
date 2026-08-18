CREATE SCHEMA IF NOT EXISTS supply;

CREATE TABLE IF NOT EXISTS supply.import_batches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('xianyu', 'general')),
  source_format text NOT NULL CHECK (source_format IN ('parsed_snapshot_json', 'parsed_snapshot_jsonl')),
  payload_hash text NOT NULL,
  received_count integer NOT NULL CHECK (received_count >= 0),
  inserted_count integer NOT NULL CHECK (inserted_count >= 0),
  deduplicated_count integer NOT NULL CHECK (deduplicated_count >= 0),
  failed_count integer NOT NULL CHECK (failed_count >= 0),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_supply_import_batches_user_recent
  ON supply.import_batches (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS supply.materials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  source_type text NOT NULL CHECK (source_type IN ('xianyu', 'general')),
  source_platform text NOT NULL,
  source_item_id text NOT NULL,
  source_url text NOT NULL,
  title text NOT NULL,
  description text,
  price numeric(14, 2) NOT NULL CHECK (price >= 0),
  main_images jsonb NOT NULL CHECK (jsonb_typeof(main_images) = 'array'),
  detail_images jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(detail_images) = 'array'),
  sku jsonb,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  import_batch_id uuid NOT NULL REFERENCES supply.import_batches(id),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'archived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, source_platform, source_item_id)
);
CREATE INDEX IF NOT EXISTS idx_supply_materials_user_recent
  ON supply.materials (user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_supply_materials_user_source
  ON supply.materials (user_id, source_type, source_platform, source_item_id);
CREATE INDEX IF NOT EXISTS idx_supply_materials_user_status
  ON supply.materials (user_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS supply.material_versions (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES supply.materials(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content_hash text NOT NULL,
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot) = 'object'),
  import_batch_id uuid NOT NULL REFERENCES supply.import_batches(id),
  created_at timestamptz NOT NULL,
  UNIQUE (material_id, version),
  UNIQUE (material_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_supply_material_versions_material_recent
  ON supply.material_versions (material_id, version DESC, id DESC);

CREATE TABLE IF NOT EXISTS supply.import_rejections (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES supply.import_batches(id) ON DELETE CASCADE,
  record_index integer NOT NULL CHECK (record_index >= 0),
  reason_code text NOT NULL,
  safe_detail text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (batch_id, record_index)
);
CREATE INDEX IF NOT EXISTS idx_supply_import_rejections_batch_recent
  ON supply.import_rejections (batch_id, created_at DESC, record_index);

COMMENT ON TABLE supply.import_batches IS 'Parsed source snapshots only. Links, cookies, tokens and browser profiles are rejected before persistence.';
COMMENT ON TABLE supply.material_versions IS 'Canonical material data only. Browser/session state and raw credential fields are never stored.';
