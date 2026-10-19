-- ============================================================
-- 063_conversations_imported_from.sql — mark conversations brought from elsewhere
--
-- When Intertec leaves Zoho, the last message of its recent WhatsApp chats
-- is imported into TUYO so each advisor can pick them up. Those chats did
-- not arrive through TUYO, so they must not count as "incoming
-- conversations" in the Conversion report. This column says where a
-- conversation came from; null = it started in TUYO.
--
--   conversations.imported_from   'zoho' for the Zoho import, otherwise null
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS imported_from text;

COMMENT ON COLUMN conversations.imported_from IS
  'Where the conversation was imported from (e.g. zoho). Null when it started in TUYO; imported ones are left out of the incoming-conversations report.';
