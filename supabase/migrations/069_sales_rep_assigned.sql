-- ============================================================
-- 069_sales_rep_assigned.sql — the CRM tells TUYO who the sales rep is
--
-- In Zoho CRM the telemarketing team assigns a SALES REP (the commercial
-- advisor who will call the customer) as the first step of a blueprint. Zoho
-- then calls a TUYO webhook (POST /api/integrations/zoho/advisor-assigned)
-- with the lead's WhatsApp number, its id and the rep's name. TUYO finds the
-- conversation by that number and:
--   - stores the rep's name and the Zoho lead id on the conversation;
--   - moves it to the stage tied to the event 'sales_rep_assigned' (forward
--     only, like the other automatic stages).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sales_rep_name text,
  ADD COLUMN IF NOT EXISTS sales_rep_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_lead_id text;

-- One more event a stage can be tied to.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_stages_auto_trigger_check'
             AND conrelid = 'conversation_stages'::regclass) THEN
    ALTER TABLE conversation_stages DROP CONSTRAINT conversation_stages_auto_trigger_check;
  END IF;
  ALTER TABLE conversation_stages ADD CONSTRAINT conversation_stages_auto_trigger_check
    CHECK (auto_trigger IS NULL OR auto_trigger IN
      ('ai_answering', 'advisor_assigned', 'lead_sent', 'sales_rep_assigned'));
END $$;

-- Record the rep on a conversation and advance its stage. Called by the
-- webhook route with the service role only.
CREATE OR REPLACE FUNCTION public.set_sales_rep(
  p_conversation uuid,
  p_name text,
  p_zoho_lead_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations c
     SET sales_rep_name = COALESCE(NULLIF(left(btrim(COALESCE(p_name, '')), 120), ''), c.sales_rep_name),
         sales_rep_assigned_at = now(),
         zoho_lead_id = COALESCE(NULLIF(left(btrim(COALESCE(p_zoho_lead_id, '')), 64), ''), c.zoho_lead_id),
         stage_id = public.stage_after(c.account_id, c.stage_id, 'sales_rep_assigned')
   WHERE c.id = p_conversation;
END;
$$;

-- Supabase grants EXECUTE on new functions to anon/authenticated by default;
-- REVOKE FROM PUBLIC does not remove those, so they are revoked by name.
REVOKE ALL ON FUNCTION public.set_sales_rep(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_rep(uuid, text, text) TO service_role;

-- stage_after (migration 068) is only used inside other definer functions and
-- triggers: nobody needs to call it from the API.
REVOKE ALL ON FUNCTION public.stage_after(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

