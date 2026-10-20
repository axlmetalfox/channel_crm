-- ============================================================
-- 065_media_description.sql — what the agent sees in a customer's photo or video
--
-- Customers send photos and videos of the machine or the product they want
-- packed. A vision model describes each one in a few sentences; the text is
-- kept on the message (`ai_description`) so the agent can answer it and the
-- advisor can see what was understood. Each description is one more model
-- call, logged under its own usage mode.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_description text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_mode_check'
      AND conrelid = 'ai_usage_log'::regclass
  ) THEN
    ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_mode_check;
  END IF;
  ALTER TABLE ai_usage_log
    ADD CONSTRAINT ai_usage_log_mode_check
    CHECK (mode IN ('auto_reply', 'draft', 'lead_extract', 'audio_transcribe', 'media_describe'));
END $$;
