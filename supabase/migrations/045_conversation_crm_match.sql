-- ============================================================
-- 045_conversation_crm_match.sql — remember whether a conversation's
-- customer is already registered in the account's CRM
--
-- The AI agent looks the customer up in the CRM (see
-- src/lib/leads/lookup.ts) so a returning customer is not interviewed
-- again. The result is kept per conversation, so each reply does not
-- repeat the lookup:
--
--   { status: 'found' | 'not_found', source: 'whatsapp' | 'claimed',
--     checked_at, module?, id?, record? }
--
-- NULL = not checked yet. Server-side only (service role); the stored
-- record is never shown to the customer or sent to the model.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS crm_match jsonb;

COMMENT ON COLUMN conversations.crm_match IS
  'Result of the CRM lookup for this conversation''s customer (found / not_found, how it was matched, the matched record). NULL = not checked.';
