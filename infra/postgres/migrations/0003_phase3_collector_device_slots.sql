ALTER TABLE identity.collector_clients
  ADD COLUMN IF NOT EXISTS active_slot smallint;

WITH ranked_active_clients AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id)::smallint AS active_slot
  FROM identity.collector_clients
  WHERE status = 'active'
)
UPDATE identity.collector_clients AS client
SET active_slot = ranked_active_clients.active_slot
FROM ranked_active_clients
WHERE client.id = ranked_active_clients.id
  AND ranked_active_clients.active_slot IN (1, 2);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM identity.collector_clients
    WHERE status = 'active' AND active_slot IS NULL
  ) THEN
    RAISE EXCEPTION 'collector client active count exceeds the two-device limit';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'collector_clients_active_slot_check'
      AND connamespace = 'identity'::regnamespace
  ) THEN
    ALTER TABLE identity.collector_clients
      ADD CONSTRAINT collector_clients_active_slot_check
      CHECK (
        (status = 'active' AND active_slot IN (1, 2))
        OR (status IN ('revoked', 'blocked') AND active_slot IS NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_collector_clients_active_slot
  ON identity.collector_clients (user_id, active_slot)
  WHERE status = 'active';
