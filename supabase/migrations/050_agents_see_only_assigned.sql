-- ============================================================
-- 050_agents_see_only_assigned.sql — let an account limit each agent to
-- the conversations assigned to them
--
-- accounts.agents_see_only_assigned (default false = today's behaviour,
-- every member sees every conversation). When true, a member whose role
-- is exactly 'agent' sees only the conversations assigned to them;
-- viewers, admins and the owner still see all of them. Messages follow
-- because their policy reads through `conversations`.
--
-- The policy goes through a SECURITY DEFINER helper so it can read the
-- flag without tripping the accounts table's own row-level security.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS agents_see_only_assigned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.agents_see_only_assigned IS
  'When true, members with the agent role only see conversations assigned to them (viewers, admins and the owner see all). Default false.';

CREATE OR REPLACE FUNCTION public.can_view_conversation(
  p_account_id uuid,
  p_assigned_agent_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id)
    AND (
      -- admins and the owner see everything
      is_account_member(p_account_id, 'admin'::account_role_enum)
      -- viewers are not restricted (the restriction is for agents)
      OR NOT is_account_member(p_account_id, 'agent'::account_role_enum)
      -- accounts that did not turn the restriction on
      OR NOT COALESCE(
           (SELECT a.agents_see_only_assigned FROM accounts a WHERE a.id = p_account_id),
           false)
      -- an agent's own conversations
      OR p_assigned_agent_id = auth.uid()
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_conversation(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations
  FOR SELECT
  USING (public.can_view_conversation(account_id, assigned_agent_id));
