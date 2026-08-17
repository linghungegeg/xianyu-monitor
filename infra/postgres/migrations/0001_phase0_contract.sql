CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS market;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS ai;

CREATE TABLE IF NOT EXISTS identity.users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'pending')),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_users_status_created ON identity.users (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS identity.admin_users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'auditor')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  mfa_state text NOT NULL CHECK (mfa_state IN ('required', 'enrolled')),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_admin_users_status_created ON identity.admin_users (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS identity.collector_clients (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_public_key_fingerprint text NOT NULL,
  device_name text NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked', 'blocked')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, device_public_key_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_collector_clients_user_status ON identity.collector_clients (user_id, status, last_seen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS identity.auth_refresh_sessions (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'admin', 'collector')),
  subject_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_subject_expiry ON identity.auth_refresh_sessions (subject_type, subject_id, expires_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing.plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  entitlement_policy_version integer NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS billing.subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  plan_id uuid NOT NULL REFERENCES billing.plans(id),
  external_reference text UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON billing.subscriptions (user_id, status, period_end DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing.orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  provider text NOT NULL,
  provider_order_id text NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (provider, provider_order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON billing.orders (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing.entitlement_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  capability text NOT NULL,
  limit_value integer NOT NULL CHECK (limit_value >= 0),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, capability, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_capability ON billing.entitlement_grants (user_id, capability, effective_to DESC, id DESC);

CREATE TABLE IF NOT EXISTS market.category_taxonomy (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  platform_category_id text NOT NULL,
  parent_id uuid REFERENCES market.category_taxonomy(id),
  name text NOT NULL,
  path text NOT NULL,
  depth integer NOT NULL CHECK (depth >= 0),
  active boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE (platform, platform_category_id)
);
CREATE INDEX IF NOT EXISTS idx_categories_parent_name ON market.category_taxonomy (parent_id, name);
CREATE INDEX IF NOT EXISTS idx_categories_platform_path ON market.category_taxonomy (platform, path);

CREATE TABLE IF NOT EXISTS market.seller_profiles (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  platform_seller_id text NOT NULL,
  public_name text,
  region text,
  public_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (platform, platform_seller_id)
);
CREATE INDEX IF NOT EXISTS idx_sellers_region ON market.seller_profiles (region, id);

CREATE TABLE IF NOT EXISTS market.seller_profile_versions (
  id uuid PRIMARY KEY,
  seller_id uuid NOT NULL REFERENCES market.seller_profiles(id),
  canonical_payload jsonb NOT NULL,
  content_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_object_key text,
  UNIQUE (seller_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_seller_versions_timeline ON market.seller_profile_versions (seller_id, observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS market.media_objects (
  id uuid PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL UNIQUE,
  visibility text NOT NULL CHECK (visibility IN ('market_public', 'restricted')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS market.items (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  platform_item_id text NOT NULL,
  seller_id uuid REFERENCES market.seller_profiles(id),
  category_id uuid REFERENCES market.category_taxonomy(id),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'sold', 'offline', 'unknown')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (platform, platform_item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_seller_recent ON market.items (seller_id, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_category_recent ON market.items (category_id, last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_state_recent ON market.items (lifecycle_state, last_seen_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS market.item_versions (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES market.items(id),
  title text,
  price numeric(14, 2),
  region text,
  condition_text text,
  want_count integer,
  canonical_payload jsonb NOT NULL,
  content_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  source_object_key text,
  UNIQUE (item_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_item_versions_timeline ON market.item_versions (item_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_item_versions_price ON market.item_versions (price, observed_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS market.item_media_relations (
  item_version_id uuid NOT NULL REFERENCES market.item_versions(id),
  media_object_id uuid NOT NULL REFERENCES market.media_objects(id),
  position integer NOT NULL CHECK (position >= 0),
  role text NOT NULL CHECK (role IN ('cover', 'gallery')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (item_version_id, media_object_id)
);
CREATE INDEX IF NOT EXISTS idx_item_media_position ON market.item_media_relations (item_version_id, position);

CREATE TABLE IF NOT EXISTS market.seller_item_relations (
  seller_id uuid NOT NULL REFERENCES market.seller_profiles(id),
  item_id uuid NOT NULL REFERENCES market.items(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'sold', 'offline', 'unknown')),
  PRIMARY KEY (seller_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_seller_items_state_recent ON market.seller_item_relations (seller_id, state, last_seen_at DESC, item_id DESC);

CREATE TABLE IF NOT EXISTS ops.collection_runs (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  client_run_id text NOT NULL,
  task_reference text,
  kind text NOT NULL CHECK (kind IN ('search', 'seller', 'detail')),
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (client_id, client_run_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_runs_client_recent ON ops.collection_runs (client_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ops.ingest_batches (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES identity.collector_clients(id),
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'processing', 'completed', 'rejected')),
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL,
  UNIQUE (client_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ingest_batches_client_recent ON ops.ingest_batches (client_id, received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ops.ingest_record_dedup (
  batch_id uuid NOT NULL REFERENCES ops.ingest_batches(id),
  record_index integer NOT NULL CHECK (record_index >= 0),
  platform_item_id text,
  payload_hash text NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (batch_id, record_index)
);

CREATE TABLE IF NOT EXISTS market.observations (
  id uuid NOT NULL,
  collected_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  collection_run_id uuid NOT NULL REFERENCES ops.collection_runs(id),
  item_id uuid REFERENCES market.items(id),
  platform_item_id text,
  platform_seller_id text,
  payload_hash text NOT NULL,
  PRIMARY KEY (collected_at, id)
) PARTITION BY RANGE (collected_at);

CREATE TABLE IF NOT EXISTS market.item_events (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  item_id uuid REFERENCES market.items(id),
  seller_id uuid REFERENCES market.seller_profiles(id),
  event_type text NOT NULL CHECK (event_type IN ('new_listing', 'price_changed', 'state_changed', 'content_changed')),
  before_version_id uuid,
  after_version_id uuid,
  event_key text NOT NULL,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS market.item_event_dedup (
  event_key text PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ops.dynamic_logs (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'collector', 'system')),
  actor_id uuid,
  client_id uuid REFERENCES identity.collector_clients(id),
  task_reference text,
  item_id uuid REFERENCES market.items(id),
  seller_id uuid REFERENCES market.seller_profiles(id),
  level text NOT NULL CHECK (level IN ('info', 'success', 'warning', 'error')),
  event_type text NOT NULL,
  safe_message text NOT NULL,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS ai.capabilities (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  published_version integer,
  input_schema jsonb NOT NULL,
  output_schema jsonb NOT NULL,
  entitlement text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ai.prompt_versions (
  id uuid PRIMARY KEY,
  capability_id uuid NOT NULL REFERENCES ai.capabilities(id),
  version integer NOT NULL,
  provider_reference text NOT NULL,
  model_reference text NOT NULL,
  prompt_body text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (capability_id, version)
);

CREATE TABLE IF NOT EXISTS ai.jobs (
  id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  requesting_user_id uuid NOT NULL REFERENCES identity.users(id),
  idempotency_key text NOT NULL,
  capability_id uuid NOT NULL REFERENCES ai.capabilities(id),
  prompt_version_id uuid NOT NULL REFERENCES ai.prompt_versions(id),
  input_object_key text,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  billing_reference text,
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS ai.insights (
  id uuid PRIMARY KEY,
  ai_job_id uuid NOT NULL,
  insight_type text NOT NULL,
  entity_reference text,
  result jsonb NOT NULL,
  confidence numeric(5, 4),
  created_at timestamptz NOT NULL,
  UNIQUE (ai_job_id, insight_type)
);
CREATE INDEX IF NOT EXISTS idx_insights_entity_recent ON ai.insights (entity_reference, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS billing.usage_ledger (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  client_id uuid REFERENCES identity.collector_clients(id),
  meter text NOT NULL,
  quantity integer NOT NULL CHECK (quantity <> 0),
  unit_price numeric(14, 6) NOT NULL,
  idempotency_key text NOT NULL,
  source_reference text,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS billing.usage_ledger_dedup (
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'collector', 'system')),
  subject_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  ledger_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (subject_type, subject_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ops.audit_logs (
  id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'collector', 'system')),
  actor_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  request_id text NOT NULL,
  ip_hash text,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

DO $$
DECLARE
  partition_month date := date_trunc('month', current_date)::date;
  next_month date;
  suffix text;
  months_ahead integer;
  parent_table text;
BEGIN
  FOREACH parent_table IN ARRAY ARRAY[
    'market.observations',
    'market.item_events',
    'ops.dynamic_logs',
    'ai.jobs',
    'billing.usage_ledger',
    'ops.audit_logs'
  ] LOOP
    FOR months_ahead IN 0..3 LOOP
      next_month := (partition_month + (months_ahead || ' months')::interval)::date;
      suffix := to_char(next_month, 'YYYYMM');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %s_%s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        replace(parent_table, '.', '_'), suffix, parent_table, next_month, (next_month + interval '1 month')::date
      );
    END LOOP;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_observations_item_time ON market.observations (platform_item_id, collected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_observations_run ON market.observations (collection_run_id, collected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_item_time ON market.item_events (item_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_seller_time ON market.item_events (seller_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON market.item_events (event_type, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_logs_actor_time ON ops.dynamic_logs (actor_type, actor_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_logs_task_time ON ops.dynamic_logs (task_reference, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_logs_item_time ON ops.dynamic_logs (item_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_logs_seller_time ON ops.dynamic_logs (seller_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status_created ON ai.jobs (status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_user_created ON ai.jobs (requesting_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_time ON billing.usage_ledger (user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON ops.audit_logs (actor_type, actor_id, occurred_at DESC, id DESC);

-- Sensitive platform credentials, browser profiles and raw auth tokens are deliberately absent.
