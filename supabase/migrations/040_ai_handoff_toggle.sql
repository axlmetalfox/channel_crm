-- ============================================================
-- 040_ai_handoff_toggle.sql — let an account turn the human handoff off
--
-- By default the AI auto-reply bot hands a conversation to a human when
-- it can't confidently help (it replies with a control phrase, pauses
-- itself on that thread, and routes it to `handoff_agent_id`).
--
-- Some deployments have no human in the loop on WhatsApp — for example a
-- lead-capture agent whose only job is to collect data for a CRM. For
-- those, a silent handoff leaves the customer with no answer. This flag
-- lets the account opt out: with `handoff_enabled = false` the bot never
-- hands off, is not told to, and keeps answering within its instructions
-- (typically "that information will come from our advisor").
--
-- Default TRUE keeps every existing account's behaviour unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN ai_configs.handoff_enabled IS
  'When false the auto-reply bot never hands a conversation to a human and is not instructed to; it keeps replying within its business instructions. Default true.';
