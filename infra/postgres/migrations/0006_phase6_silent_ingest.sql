ALTER TABLE ops.ingest_batches
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS device_id uuid,
  ADD COLUMN IF NOT EXISTS batch_sequence bigint,
  ADD COLUMN IF NOT EXISTS cursor_start text,
  ADD COLUMN IF NOT EXISTS cursor_end text,
  ADD COLUMN IF NOT EXISTS received_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deduplicated_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inserted_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quality_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS quality_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingest_batches_quality_status_check') THEN
    ALTER TABLE ops.ingest_batches ADD CONSTRAINT ingest_batches_quality_status_check
      CHECK (quality_status IN ('pending', 'passed', 'warning', 'failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_batches_device_sequence
  ON ops.ingest_batches (client_id, batch_sequence)
  WHERE batch_sequence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingest_batches_device_status_time
  ON ops.ingest_batches (client_id, status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_batches_quality_time
  ON ops.ingest_batches (quality_status, received_at DESC, id DESC);

ALTER TABLE ops.ingest_record_dedup
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS entity_type text,
  ADD COLUMN IF NOT EXISTS entity_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS inserted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_ingest_record_dedup_entity
  ON ops.ingest_record_dedup (entity_type, entity_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_record_dedup_failure
  ON ops.ingest_record_dedup (status, failure_reason, processed_at DESC);

CREATE TABLE IF NOT EXISTS ops.ingest_entity_dedup (
  idempotency_key text PRIMARY KEY,
  entity_type text NOT NULL,
  payload_hash text NOT NULL,
  first_batch_id uuid NOT NULL REFERENCES ops.ingest_batches(id),
  accepted_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_entity_dedup_type_time
  ON ops.ingest_entity_dedup (entity_type, accepted_at DESC);

CREATE TABLE IF NOT EXISTS ops.ingest_rejections (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES ops.ingest_batches(id) ON DELETE CASCADE,
  record_index integer NOT NULL CHECK (record_index >= 0),
  idempotency_key text,
  entity_type text,
  failure_reason text NOT NULL,
  safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (batch_id, record_index)
);
CREATE INDEX IF NOT EXISTS idx_ingest_rejections_batch_time
  ON ops.ingest_rejections (batch_id, created_at DESC, record_index);
CREATE INDEX IF NOT EXISTS idx_ingest_rejections_reason_time
  ON ops.ingest_rejections (failure_reason, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ops.ingest_media_uploads (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES ops.ingest_batches(id) ON DELETE CASCADE,
  media_id uuid REFERENCES market.media_objects(id),
  object_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'deduplicated', 'rejected')),
  created_at timestamptz NOT NULL,
  UNIQUE (batch_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_ingest_media_uploads_batch_time
  ON ops.ingest_media_uploads (batch_id, created_at DESC, id DESC);

COMMENT ON TABLE ops.ingest_rejections IS 'Phase 6 safe validation failures; never stores credentials or browser state';
COMMENT ON TABLE ops.ingest_media_uploads IS 'Phase 6 public media metadata only; binary storage is intentionally out of scope';
