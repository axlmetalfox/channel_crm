-- ============================================================
-- 067_conversation_stages.sql — custom stages for conversations
--
-- The conversation status (open / pending / closed) drives the automation
-- (who is waiting for whom, the counters, the sweeps) and stays fixed. A
-- STAGE is a second, independent label the account defines itself, such as
-- "Asesor Comercial Asignado" (the sales rep has been picked and will call
-- the customer). Admins and the owner add, rename, recolor, reorder and
-- remove stages in Settings; anyone who answers chats sets a conversation's
-- stage. Deleting a stage leaves its conversations without a stage.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  color text NOT NULL DEFAULT '#8b5cf6',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_stages_name_idx
  ON conversation_stages (account_id, lower(btrim(name)));

ALTER TABLE conversation_stages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_stages_select ON conversation_stages;
CREATE POLICY conversation_stages_select ON conversation_stages
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS conversation_stages_insert ON conversation_stages;
CREATE POLICY conversation_stages_insert ON conversation_stages
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));

DROP POLICY IF EXISTS conversation_stages_update ON conversation_stages;
CREATE POLICY conversation_stages_update ON conversation_stages
  FOR UPDATE USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));

DROP POLICY IF EXISTS conversation_stages_delete ON conversation_stages;
CREATE POLICY conversation_stages_delete ON conversation_stages
  FOR DELETE USING (is_account_member(account_id, 'admin'::account_role_enum));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS stage_id uuid REFERENCES conversation_stages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_stage_idx
  ON conversations (stage_id) WHERE stage_id IS NOT NULL;

-- First stage for every account.
INSERT INTO conversation_stages (account_id, name, color, position)
SELECT a.id, 'Asesor Comercial Asignado', '#8b5cf6', 0
FROM accounts a
ON CONFLICT DO NOTHING;
