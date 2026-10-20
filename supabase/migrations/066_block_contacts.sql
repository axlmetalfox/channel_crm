-- ============================================================
-- 066_block_contacts.sql — block abusive or fake contacts
--
-- Anyone who can answer chats (agent, admin, owner) can block a contact who
-- sends offensive material or is not a real customer. Blocking:
--   - marks the contact (who, when, why) so the inbox stops treating it as a
--     live conversation;
--   - closes the contact's conversations and switches the AI agent off there.
-- Only an admin or the owner can unblock.
--
-- Messages from a blocked contact are still stored (as evidence) but trigger
-- nothing: the inbound handler checks contacts.blocked_at. Blocking the
-- number on WhatsApp itself is done by the API route through Zernio.
--
-- messages.ai_flag marks a photo or video the vision model judged to be
-- explicit or offensive ('offensive'); the inbox blurs it and the AI stays
-- out of that conversation until a person decides.
--
-- Both functions run as the caller (SECURITY DEFINER, auth.uid() preserved)
-- and answer "not_found" for a contact the caller may not open.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS block_reason text,
  ADD COLUMN IF NOT EXISTS block_note text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_block_reason_check'
                 AND conrelid = 'contacts'::regclass) THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_block_reason_check
      CHECK (block_reason IS NULL OR block_reason IN ('offensive', 'fake', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS contacts_blocked_idx ON contacts (account_id) WHERE blocked_at IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_flag text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_ai_flag_check'
                 AND conrelid = 'messages'::regclass) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_ai_flag_check
      CHECK (ai_flag IS NULL OR ai_flag IN ('offensive'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.block_contact(
  p_contact_id uuid,
  p_reason text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_reason IS NULL OR p_reason NOT IN ('offensive', 'fake', 'other') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;

  SELECT c.account_id, c.user_id INTO v_account, v_owner
  FROM contacts c
  WHERE c.id = p_contact_id
  FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(public.can_view_contact(v_account, p_contact_id, v_owner), false) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE(is_account_member(v_account, 'agent'::account_role_enum), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE contacts
     SET blocked_at = now(),
         blocked_by = v_uid,
         block_reason = p_reason,
         block_note = NULLIF(left(btrim(COALESCE(p_note, '')), 500), ''),
         updated_at = now()
   WHERE id = p_contact_id;

  UPDATE conversations
     SET status = 'closed',
         ai_autoreply_disabled = true,
         updated_at = now()
   WHERE contact_id = p_contact_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unblock_contact(p_contact_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT c.account_id INTO v_account
  FROM contacts c
  WHERE c.id = p_contact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE(is_account_member(v_account, 'admin'::account_role_enum), false) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE contacts
     SET blocked_at = NULL,
         blocked_by = NULL,
         block_reason = NULL,
         block_note = NULL,
         updated_at = now()
   WHERE id = p_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.block_contact(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.block_contact(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.unblock_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unblock_contact(uuid) TO authenticated;
