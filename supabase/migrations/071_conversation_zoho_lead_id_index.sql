-- ============================================================
-- 071_conversation_zoho_lead_id_index.sql — find a chat by its Zoho lead id
--
-- TUYO now remembers the Zoho lead id of each customer's lead
-- (conversations.zoho_lead_id, filled from the CRM bridge's answer when the
-- lead is delivered). Zoho's webhooks identify the lead by that id, which is
-- the only way to find the chat of a customer whose WhatsApp number is hidden.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE INDEX IF NOT EXISTS conversations_zoho_lead_id_idx
  ON conversations (account_id, zoho_lead_id)
  WHERE zoho_lead_id IS NOT NULL;
