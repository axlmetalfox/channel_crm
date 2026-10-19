-- ============================================================
-- 059_validate_manual_leads.sql — admin switch for the manual-lead data check
--
-- Sending a lead to the CRM by hand (/enviarZoho) can require that the
-- customer's data really came from the customer: the form is read-only and
-- a corrected value is accepted only if the customer wrote it in the chat.
-- This switch lets an admin turn that check off, which leaves the fields
-- free to type in.
--
--   accounts.validate_manual_leads   true (default) = check the data
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS validate_manual_leads boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN accounts.validate_manual_leads IS
  'true: manual leads must use data the customer wrote in the chat (read-only form). false: the agent can type any value.';
