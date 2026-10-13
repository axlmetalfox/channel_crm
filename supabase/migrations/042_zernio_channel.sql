-- ============================================================
-- 042_zernio_channel.sql — WhatsApp through Zernio (non-Meta channel)
--
-- An account can receive and send WhatsApp through Zernio's inbox API
-- instead of wiring its own Meta app:
--
--   1. zernio_config — one row per account: the (encrypted) Zernio API
--      key, the Zernio account id of the connected WhatsApp number, and
--      the webhook endpoint wacrm registered at Zernio (an unguessable
--      path token + an encrypted HMAC secret we chose).
--   2. conversations.zernio_conversation_id — Zernio addresses replies
--      by ITS conversation id, so we keep the one it gave us on the
--      first inbound message.
--
-- When an account has an active zernio_config the send paths use it;
-- accounts without one behave exactly as before (Meta Cloud API).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS zernio_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit / sender-of-record for rows created by inbound processing
  -- (same role whatsapp_config.user_id plays).
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  api_key            text NOT NULL,   -- AES-256-GCM-encrypted Zernio API key
  zernio_account_id  text NOT NULL,   -- Zernio `accountId` of the WhatsApp number
  webhook_token      text NOT NULL UNIQUE,  -- random path segment of our webhook URL
  webhook_secret     text NOT NULL,   -- AES-256-GCM-encrypted HMAC signing secret
  zernio_webhook_id  text,            -- id of the endpoint registered at Zernio (if returned)
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE zernio_config ENABLE ROW LEVEL SECURITY;

-- The roster is settings-class: only admin+ may read or change it (the
-- encrypted key and secret live here). Inbound/outbound processing uses
-- the service-role client, which bypasses RLS.
DROP POLICY IF EXISTS zernio_config_select ON zernio_config;
CREATE POLICY zernio_config_select ON zernio_config FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zernio_config_insert ON zernio_config;
CREATE POLICY zernio_config_insert ON zernio_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zernio_config_update ON zernio_config;
CREATE POLICY zernio_config_update ON zernio_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zernio_config_delete ON zernio_config;
CREATE POLICY zernio_config_delete ON zernio_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_zernio_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zernio_config_updated_at ON zernio_config;
CREATE TRIGGER zernio_config_updated_at
  BEFORE UPDATE ON zernio_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_zernio_config_updated_at();

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS zernio_conversation_id text;

COMMENT ON COLUMN conversations.zernio_conversation_id IS
  'Zernio conversation id for this thread (set from the first inbound message); outbound replies are addressed to it.';
