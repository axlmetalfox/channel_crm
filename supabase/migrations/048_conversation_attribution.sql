-- ============================================================
-- 048_conversation_attribution.sql — where a chat came from
--
-- A chat that starts from a click-to-WhatsApp ad or post arrives with
-- Meta's `referral` (passed on by Zernio in `metadata.referral`). The
-- newest one is kept per conversation, so a lead can say which ad it
-- came from:
--
--   { source_type, source_id, source_url, headline, body, media_type,
--     ctwa_clid, captured_at }
--
-- NULL = organic / not from an ad. Server-side only (service role).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS attribution jsonb;

COMMENT ON COLUMN conversations.attribution IS
  'Click-to-WhatsApp source of the newest ad click that opened or re-opened this chat (ad/post id, link, headline, ctwa_clid). NULL = not from an ad.';
