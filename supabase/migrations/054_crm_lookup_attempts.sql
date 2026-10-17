-- ============================================================
-- 054_crm_lookup_attempts.sql — cap the email checks per conversation
--
-- When a customer says the business already has their details, the agent
-- checks their email against the CRM. The answer is yes/no, so repeating
-- the check with different emails could be used to find out which emails
-- are registered. The app counts the checks per conversation and stops
-- after a few (see MAX_VERIFICATIONS_PER_CONVERSATION).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS crm_lookup_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN conversations.crm_lookup_attempts IS
  'How many email checks against the CRM this conversation has run (capped, so the check cannot be used to probe which emails are registered).';
