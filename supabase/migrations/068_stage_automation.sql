-- ============================================================
-- 068_stage_automation.sql — stages that move on their own
--
-- A stage can be tied to an event (conversation_stages.auto_trigger):
--   ai_answering      the AI agent sends a reply in the chat
--   advisor_assigned  the chat is assigned to a person of the team
--   lead_sent         the lead was delivered to the CRM (Zoho)
-- When the event happens, the conversation moves to that stage, but only
-- FORWARD: if it already sits on a stage that comes later in the account's
-- order (e.g. a hand-picked "Asesor Comercial Asignado" or "Archivado"), it
-- stays. So the order of the stages in Settings is the order of the process.
-- Stages without a trigger are set by hand (or by a quick reply, see
-- quick_replies.stage_id: sending that quick reply moves the chat there).
--
-- The three events are caught in the database (triggers), so every path that
-- causes them is covered: the AI, flows, the assignment rules, the Transfer
-- button, the manual lead form. apply_stage_automation() fills the stage of
-- the conversations that have none yet (admins only, on demand).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversation_stages
  ADD COLUMN IF NOT EXISTS auto_trigger text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_stages_auto_trigger_check'
                 AND conrelid = 'conversation_stages'::regclass) THEN
    ALTER TABLE conversation_stages ADD CONSTRAINT conversation_stages_auto_trigger_check
      CHECK (auto_trigger IS NULL OR auto_trigger IN ('ai_answering', 'advisor_assigned', 'lead_sent'));
  END IF;
END $$;

-- One stage per event per account.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_stages_trigger_idx
  ON conversation_stages (account_id, auto_trigger) WHERE auto_trigger IS NOT NULL;

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS stage_id uuid REFERENCES conversation_stages(id) ON DELETE SET NULL;

-- The stage a conversation should have after `p_trigger` happens: the stage
-- tied to it, unless the conversation is already on that one or a later one.
CREATE OR REPLACE FUNCTION public.stage_after(
  p_account uuid,
  p_current uuid,
  p_trigger text
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN t.id IS NULL THEN p_current
    WHEN p_current IS NULL THEN t.id
    WHEN cur.id IS NULL THEN t.id
    WHEN cur.position < t.position THEN t.id
    ELSE p_current
  END
  FROM (SELECT 1) one
  LEFT JOIN conversation_stages t
    ON t.account_id = p_account AND t.auto_trigger = p_trigger
  LEFT JOIN conversation_stages cur
    ON cur.id = p_current AND cur.account_id = p_account;
$$;

-- 1) Assigned to a person of the team.
CREATE OR REPLACE FUNCTION public.stage_on_assignment() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.stage_id := public.stage_after(NEW.account_id, NEW.stage_id, 'advisor_assigned');
    ELSIF OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id THEN
      NEW.stage_id := public.stage_after(NEW.account_id, NEW.stage_id, 'advisor_assigned');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_stage_on_assignment ON conversations;
CREATE TRIGGER conversations_stage_on_assignment
  BEFORE INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.stage_on_assignment();

-- 2) The AI agent replied.
CREATE OR REPLACE FUNCTION public.stage_on_ai_reply() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations c
     SET stage_id = public.stage_after(c.account_id, c.stage_id, 'ai_answering')
   WHERE c.id = NEW.conversation_id
     AND c.stage_id IS DISTINCT FROM public.stage_after(c.account_id, c.stage_id, 'ai_answering');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS messages_stage_on_ai_reply ON messages;
CREATE TRIGGER messages_stage_on_ai_reply
  AFTER INSERT ON messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'bot' AND NEW.ai_generated IS TRUE)
  EXECUTE FUNCTION public.stage_on_ai_reply();

-- 3) The lead reached the CRM.
CREATE OR REPLACE FUNCTION public.stage_on_lead_delivered() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE conversations c
     SET stage_id = public.stage_after(c.account_id, c.stage_id, 'lead_sent')
   WHERE c.id = NEW.conversation_id
     AND c.stage_id IS DISTINCT FROM public.stage_after(c.account_id, c.stage_id, 'lead_sent');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lead_intakes_stage_on_delivered ON lead_intakes;
CREATE TRIGGER lead_intakes_stage_on_delivered
  AFTER INSERT OR UPDATE OF status ON lead_intakes
  FOR EACH ROW
  WHEN (NEW.status = 'delivered' AND NEW.conversation_id IS NOT NULL)
  EXECUTE FUNCTION public.stage_on_lead_delivered();

-- Fill in the stage of the conversations that have none, from what already
-- happened in them: lead delivered > assigned to a person > AI replied.
-- Conversations that already have a stage are left alone. Admins/owner only.
CREATE OR REPLACE FUNCTION public.apply_stage_automation() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_n integer := 0;
  v_step integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT p.account_id INTO v_account FROM profiles p WHERE p.user_id = v_uid LIMIT 1;
  IF v_account IS NULL OR NOT COALESCE(is_account_member(v_account, 'admin'::account_role_enum), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Highest event first, so a conversation lands on the furthest stage.
  UPDATE conversations c
     SET stage_id = public.stage_after(c.account_id, c.stage_id, 'lead_sent')
   WHERE c.account_id = v_account AND c.stage_id IS NULL
     AND EXISTS (SELECT 1 FROM lead_intakes li WHERE li.conversation_id = c.id AND li.status = 'delivered')
     AND public.stage_after(c.account_id, c.stage_id, 'lead_sent') IS NOT NULL;
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;

  UPDATE conversations c
     SET stage_id = public.stage_after(c.account_id, c.stage_id, 'advisor_assigned')
   WHERE c.account_id = v_account AND c.stage_id IS NULL AND c.assigned_agent_id IS NOT NULL
     AND public.stage_after(c.account_id, c.stage_id, 'advisor_assigned') IS NOT NULL;
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;

  UPDATE conversations c
     SET stage_id = public.stage_after(c.account_id, c.stage_id, 'ai_answering')
   WHERE c.account_id = v_account AND c.stage_id IS NULL
     AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'bot' AND m.ai_generated IS TRUE)
     AND public.stage_after(c.account_id, c.stage_id, 'ai_answering') IS NOT NULL;
  GET DIAGNOSTICS v_step = ROW_COUNT; v_n := v_n + v_step;

  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stage_automation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_stage_automation() TO authenticated;
