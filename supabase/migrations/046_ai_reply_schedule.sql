-- ============================================================
-- 046_ai_reply_schedule.sql — hours when the AI agent answers
--
-- A business that answers its own chats during office hours can have
-- the agent cover the rest. NULL = always on duty. Otherwise:
--
--   { "timezone": "America/Bogota",
--     "windows": [ { "days": [1,2,3,4], "start": "17:00", "end": "07:30" }, … ] }
--
-- days: 0 = Sunday … 6 = Saturday; a window whose end is not after its
-- start runs overnight into the next day. See src/lib/ai/schedule.ts.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_schedule jsonb;

COMMENT ON COLUMN ai_configs.auto_reply_schedule IS
  'Weekly windows (time zone + days/start/end) when the AI agent answers; NULL = always. Outside them the message waits for a person.';
