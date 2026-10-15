-- ============================================================
-- 043_ai_usage_router_credits.sql — record what each LLM call cost us
--
-- The AI gateway we resell through (Hostinger AI router) reports the
-- cost of every response in `usage.credits_charged`. Storing it per call
-- is what lets us price interactions from measured data instead of
-- guesses: cost per captured lead, per conversation, per account.
--
-- This is TUYO CRM's own cost, in the gateway's credits. It is not the
-- customer-facing credit and is never shown to customers.
--
-- NULL when the provider does not report it (e.g. api.openai.com).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS router_credits numeric(14, 6);

COMMENT ON COLUMN ai_usage_log.router_credits IS
  'Gateway-reported cost of this call (Hostinger AI router usage.credits_charged), in the gateway''s credits. NULL if not reported. Internal cost data — not the customer-facing credit.';
