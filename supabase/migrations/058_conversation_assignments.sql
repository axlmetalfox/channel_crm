-- ============================================================
-- 058_conversation_assignments.sql — who got which conversation, and when
--
-- conversations only holds the CURRENT assignee, so nothing recorded how
-- many conversations each person received or when. This log gets one row
-- every time a conversation is assigned to someone (by hand from the inbox,
-- by taking it over from the AI, or by the auto-assignment rule), which the
-- dashboard uses for each agent's effectiveness (registered / received) and
-- the time from receiving a chat to registering the lead.
--
-- Rows are written by a trigger, so every path is covered without touching
-- the application code. A failure to log never blocks the assignment.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Who made the assignment; null for the automatic rule and for the backfill.
  assigned_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  -- true for rows created from the assignments that existed when this log
  -- started (their assigned_at is only the conversation's last update).
  backfilled       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS conversation_assignments_account_time_idx
  ON conversation_assignments (account_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS conversation_assignments_conversation_idx
  ON conversation_assignments (conversation_id, assigned_at DESC);

ALTER TABLE conversation_assignments ENABLE ROW LEVEL SECURITY;

-- Members of the account can read the log; only the trigger writes it.
DROP POLICY IF EXISTS conversation_assignments_select ON conversation_assignments;
CREATE POLICY conversation_assignments_select ON conversation_assignments FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION log_conversation_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO conversation_assignments (account_id, conversation_id, agent_id, assigned_by)
  VALUES (NEW.account_id, NEW.id, NEW.assigned_agent_id, auth.uid());

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log assignment of conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_conversation_assignment_log ON conversations;
CREATE TRIGGER on_conversation_assignment_log
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION log_conversation_assignment();

-- Start the log with the assignments that exist today (once).
INSERT INTO conversation_assignments (account_id, conversation_id, agent_id, assigned_at, backfilled)
SELECT c.account_id, c.id, c.assigned_agent_id, c.updated_at, true
FROM conversations c
WHERE c.assigned_agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM conversation_assignments a WHERE a.conversation_id = c.id
  );

COMMENT ON TABLE conversation_assignments IS
  'One row each time a conversation is assigned to a person; feeds the per-agent effectiveness report.';
