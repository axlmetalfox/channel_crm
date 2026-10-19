-- ============================================================
-- 060_tighten_agent_visibility.sql — agents only read what is theirs
--
-- Until now every member of an account could read, straight from the
-- database, tables that hold sensitive or other people's data:
--
--   ai_configs         the AI agent's full prompt (and its encrypted keys)
--   webhook_endpoints  the CRM webhook URL and its (encrypted) secret
--   api_keys           names and prefixes of the account's API keys
--   lead_intakes       every customer's lead, with contact data and the
--                      conversation transcript
--   conversation_assignments  who received which chat (the new stats)
--
-- The app's screens never showed them to agents, but the API behind them
-- answered anyone. Now:
--
--   ai_configs, webhook_endpoints, api_keys   admins and the owner only
--   lead_intakes     admins, the agent who sent the lead, and whoever can
--                    already open the lead's conversation (agents see
--                    unassigned chats and their own, see 050)
--   conversation_assignments   admins, or the agent it was assigned to
--
-- The server reads these with the service role, so nothing it does changes.
-- whatsapp_config is left as is: the inbox reads its connection status
-- for every role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS ai_configs_select ON ai_configs;
CREATE POLICY ai_configs_select ON ai_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS webhook_endpoints_select ON webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON webhook_endpoints FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS api_keys_select ON api_keys;
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_intakes_select ON lead_intakes;
CREATE POLICY lead_intakes_select ON lead_intakes FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR created_by_user_id = auth.uid()
    -- Subject to the conversations policy: only chats the user can open.
    OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = lead_intakes.conversation_id)
  );

DROP POLICY IF EXISTS conversation_assignments_select ON conversation_assignments;
CREATE POLICY conversation_assignments_select ON conversation_assignments FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR agent_id = auth.uid()
  );
