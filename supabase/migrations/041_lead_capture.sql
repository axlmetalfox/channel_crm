-- ============================================================
-- 041_lead_capture.sql — lead capture for capture-only AI agents
--
-- A capture-only agent (no human watching the inbox) interviews the
-- customer over WhatsApp and, when it finishes, wacrm extracts the data
-- the customer gave, validates it, and delivers it to the account's CRM
-- through the existing outbound webhooks (event `lead.captured`).
--
--   1. ai_configs.lead_capture_enabled — per-account opt-in. Default
--      FALSE so no existing account changes behaviour.
--   2. lead_intakes — one row per finished interview. It is the
--      idempotency key (a retried send can't create two leads) and the
--      audit trail / retry queue (what was captured, whether it reached
--      the CRM, why not).
--
-- A contact may have many intakes: the same person asking for a quote
-- today and for service next month is two separate leads on purpose.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS lead_capture_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN ai_configs.lead_capture_enabled IS
  'When true, the auto-reply bot may finish an interview with a completion marker, after which wacrm extracts the lead and delivers it via the lead.captured webhook event. Default false.';

CREATE TABLE IF NOT EXISTS lead_intakes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Provider message id of the closing reply that ended the interview.
  -- Unique per account: re-processing the same closing message is a no-op.
  trigger_message_id text NOT NULL,
  -- pending     created, not yet delivered (also the retry state)
  -- delivered   every subscribed endpoint accepted it
  -- failed      delivery attempted, at least one endpoint refused / errored
  -- no_endpoint nobody is subscribed to lead.captured (retriable once set up)
  -- incomplete  extraction did not yield the mandatory fields (not sent)
  -- no_consent  the customer never gave data-processing consent (not sent)
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'delivered', 'failed',
                                       'no_endpoint', 'incomplete', 'no_consent')),
  payload            jsonb,
  error              text,
  attempts           integer NOT NULL DEFAULT 0,
  last_attempt_at    timestamptz,
  delivered_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, trigger_message_id)
);

CREATE INDEX IF NOT EXISTS lead_intakes_account_status_idx
  ON lead_intakes (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_intakes_conversation_idx
  ON lead_intakes (conversation_id, created_at DESC);

ALTER TABLE lead_intakes ENABLE ROW LEVEL SECURITY;

-- Members can read their account's intakes (a future dashboard). All
-- writes come from the service role (the webhook / retry route), so no
-- INSERT / UPDATE / DELETE policy is defined.
DROP POLICY IF EXISTS lead_intakes_select ON lead_intakes;
CREATE POLICY lead_intakes_select ON lead_intakes FOR SELECT
  USING (is_account_member(account_id));

-- Lead extraction is an LLM call of its own; let ai_usage_log record it
-- under its own mode so its cost shows up separately from replies.
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
    CHECK (mode IN ('auto_reply', 'draft', 'lead_extract'));
END $$;
