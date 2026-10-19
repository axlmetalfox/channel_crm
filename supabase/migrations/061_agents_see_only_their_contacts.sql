-- ============================================================
-- 061_agents_see_only_their_contacts.sql — contacts follow the same switch
--
-- Migration 050 added accounts.agents_see_only_assigned: when it is on, an
-- agent only opens the conversations assigned to them. Contacts were left
-- out, so an agent could still browse every customer's name, phone and
-- email in the Contacts page. With the switch on, an agent now sees only
--
--   - contacts they created (or imported) themselves, and
--   - contacts of conversations assigned to them.
--
-- Admins, the owner and viewers always see everything, and with the switch
-- off nothing changes. Notes on a contact follow the contact. Tags and
-- custom values already read through contacts, so they follow too.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_view_contact(
  p_account_id uuid,
  p_contact_id uuid,
  p_created_by uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id)
    AND (
      is_account_member(p_account_id, 'admin'::account_role_enum)
      OR NOT is_account_member(p_account_id, 'agent'::account_role_enum)
      OR NOT COALESCE(
           (SELECT a.agents_see_only_assigned FROM accounts a WHERE a.id = p_account_id),
           false)
      -- a contact the agent created or imported
      OR p_created_by = auth.uid()
      -- a contact of one of the agent's conversations
      OR EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.contact_id = p_contact_id
          AND c.assigned_agent_id = auth.uid()
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_view_contact(uuid, uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (public.can_view_contact(account_id, id, user_id));

-- Notes belong to a contact: visible with it (the subquery is itself
-- subject to the contacts policy above).
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
