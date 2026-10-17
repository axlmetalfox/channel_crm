-- ============================================================
-- 056_usage_audio_transcribe.sql — log voice-note transcriptions
--
-- Turning a customer's voice note into text is one more model call. It is
-- recorded in ai_usage_log (with its router credits) under its own mode so
-- its cost shows separately from replies and lead extraction.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

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
    CHECK (mode IN ('auto_reply', 'draft', 'lead_extract', 'audio_transcribe'));
END $$;
