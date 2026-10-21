-- ============================================================
-- 072_viewer_reads_assignments.sql — the observer can read the assignment log
--
-- The conversion report counts the conversations handed to each advisor from
-- the assignment log (conversation_assignments). Migration 060 let only admins
-- and the advisor herself read it, so an observer (viewer), who may read every
-- conversation, saw an incomplete report. Observers get read access to the log
-- of their own account: it only says who received which conversation and when,
-- which the conversation list already shows them.
--
-- Agents keep seeing only their own rows. Idempotent.
-- ============================================================

DROP POLICY IF EXISTS conversation_assignments_select ON conversation_assignments;
CREATE POLICY conversation_assignments_select ON conversation_assignments FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR agent_id = auth.uid()
    -- A member below the agent role: the observer.
    OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent'))
  );
