-- ============================================================
-- 073_channel_health.sql — know when the WhatsApp number is disconnected
--
-- The 5-minute sweep now asks Zernio/Meta for the live status of each
-- connected number and keeps the result on its zernio_config row, so the app
-- can warn everyone (a banner) and the scheduler can raise an alert. A number
-- is only declared down after two consecutive bad readings (a single hiccup is
-- ignored), and the alert fires once per outage.
--
-- Written only by the server (service role). The banner reads it through an
-- API route that returns just these fields, never the encrypted key.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE zernio_config
  ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS connection_fail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS connection_down_since timestamptz,
  ADD COLUMN IF NOT EXISTS connection_alerted_at timestamptz,
  ADD COLUMN IF NOT EXISTS connection_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS connection_detail text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zernio_config_connection_status_check'
                 AND conrelid = 'zernio_config'::regclass) THEN
    ALTER TABLE zernio_config ADD CONSTRAINT zernio_config_connection_status_check
      CHECK (connection_status IN ('connected', 'disconnected', 'unknown'));
  END IF;
END $$;
