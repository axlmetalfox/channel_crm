-- ============================================================
-- 064_transfer_conversation.sql — agents can hand a chat to a colleague
--
-- With agents_see_only_assigned on, an agent sees only her own
-- conversations, so a plain UPDATE of assigned_agent_id fails: the row
-- would stop being visible to her ("new row violates row-level security").
-- This function does the hand-over with the checks done in one place:
--
--   - the caller must be able to open the conversation;
--   - she must own it (or be an admin / the owner), or it must be unassigned
--     (only possible when the account lets agents see unassigned chats);
--   - the new owner must be an agent, admin or owner of the same account
--     (never a viewer, never someone from another account);
--   - a NULL target releases the conversation (unassigned).
--
-- It runs as the caller (auth.uid() is preserved), so the existing triggers
-- keep working: the new owner gets the "assigned to you" notification naming
-- who sent it, and the assignment log (conversation_assignments) records it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.transfer_conversation(
  p_conversation_id uuid,
  p_to_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_assigned uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT c.account_id, c.assigned_agent_id
    INTO v_account, v_assigned
  FROM conversations c
  WHERE c.id = p_conversation_id
  FOR UPDATE;

  -- Not there, or not one the caller may open: same answer for both.
  -- can_view_conversation() is NULL (not false) for an unassigned chat the
  -- caller may not see: treat NULL as "no".
  IF NOT FOUND OR NOT COALESCE(public.can_view_conversation(v_account, v_assigned), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE(is_account_member(v_account, 'agent'::account_role_enum), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    COALESCE(is_account_member(v_account, 'admin'::account_role_enum), false)
    OR v_assigned IS NULL
    OR v_assigned = v_uid
  ) THEN
    RAISE EXCEPTION 'not_owner' USING ERRCODE = '42501';
  END IF;

  IF p_to_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = p_to_user_id
      AND p.account_id = v_account
      AND p.account_role IN ('agent', 'admin', 'owner')
  ) THEN
    RAISE EXCEPTION 'invalid_target' USING ERRCODE = '22023';
  END IF;

  UPDATE conversations
     SET assigned_agent_id = p_to_user_id,
         updated_at = now()
   WHERE id = p_conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_conversation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_conversation(uuid, uuid) TO authenticated;
