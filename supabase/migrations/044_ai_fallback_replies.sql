-- ============================================================
-- 044_ai_fallback_replies.sql — fixed replies for the cases the model
-- cannot (or should not) answer
--
-- The AI agent only reads text, and it stops after a per-conversation
-- cap. Both used to end in silence, which reads as "ignored" to a real
-- customer. Two optional, per-account replies close those gaps:
--
--   non_text_reply   sent when the customer sends something that is not
--                    text (a voice note, a photo, a document…)
--   reply_limit_reply sent once when the conversation reaches the cap
--
-- NULL means "use the built-in default" (Spanish or English, see
-- src/lib/ai/fallback.ts). Neither costs an AI call.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS non_text_reply text,
  ADD COLUMN IF NOT EXISTS reply_limit_reply text;

COMMENT ON COLUMN ai_configs.non_text_reply IS
  'Fixed reply sent when the customer sends a non-text message (voice note, image…). NULL = built-in default.';
COMMENT ON COLUMN ai_configs.reply_limit_reply IS
  'Fixed reply sent once when the per-conversation auto-reply cap is reached. NULL = built-in default.';
