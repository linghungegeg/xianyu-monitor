CREATE TABLE IF NOT EXISTS market.region_taxonomy (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  region text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL,
  UNIQUE (platform, region)
);
CREATE INDEX IF NOT EXISTS idx_region_taxonomy_platform_name
  ON market.region_taxonomy (platform, region);
CREATE INDEX IF NOT EXISTS idx_region_taxonomy_observed
  ON market.region_taxonomy (observed_at DESC, id DESC);
