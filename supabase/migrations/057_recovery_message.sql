-- ============================================================
-- 057_recovery_message.sql — nudge customers who went quiet
--
-- When the AI agent asked the customer something and they have not
-- answered after a while, the account can have it send ONE short message
-- the admin wrote ("Estoy muy atento para ayudarte a completar tu
-- requerimiento"), to bring the conversation back.
--
--   ai_configs.recovery_enabled / recovery_after_minutes / recovery_message
--   conversations.recovery_nudge_at   when the nudge was sent, so each
--                                     silence gets at most one
--
-- WhatsApp only lets a business write freely within 24 hours of the
-- customer's last message, so the wait is capped below that (10 minutes
-- to 23 hours). recovery_candidates() finds the conversations that are due.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS recovery_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_after_minutes integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS recovery_message text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_recovery_after_minutes_check'
                 AND conrelid = 'ai_configs'::regclass) THEN
    ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_recovery_after_minutes_check
      CHECK (recovery_after_minutes BETWEEN 10 AND 1380);
  END IF;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS recovery_nudge_at timestamptz;

COMMENT ON COLUMN ai_configs.recovery_message IS
  'Text of the one-time recovery message sent to a customer who has not answered the agent for recovery_after_minutes.';
COMMENT ON COLUMN conversations.recovery_nudge_at IS
  'When the recovery message was last sent in this conversation; one per customer silence.';

-- Conversations due a nudge: the agent spoke last and asked something, the
-- customer has been quiet for p_idle_minutes, their last message is still
-- inside the free-text window, nobody owns the conversation, and it has not
-- been nudged since the customer's last message.
CREATE OR REPLACE FUNCTION public.recovery_candidates(
  p_account_id uuid,
  p_idle_minutes integer,
  p_window_minutes integer,
  p_limit integer
) RETURNS TABLE (conversation_id uuid, contact_id uuid, previous_nudge_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.contact_id, c.recovery_nudge_at
  FROM conversations c
  JOIN LATERAL (
    SELECT m.created_at
    FROM messages m
    WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
    ORDER BY m.created_at DESC
    LIMIT 1
  ) lc ON true
  JOIN LATERAL (
    SELECT m.sender_type, m.created_at, m.content_text
    FROM messages m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC
    LIMIT 1
  ) lm ON true
  WHERE c.account_id = p_account_id
    AND c.status IN ('open', 'pending')
    AND c.assigned_agent_id IS NULL
    AND c.ai_autoreply_disabled = false
    AND c.zernio_conversation_id IS NOT NULL
    AND lm.sender_type = 'bot'
    AND lm.content_text LIKE '%?%'
    AND lm.created_at <= now() - make_interval(mins => p_idle_minutes)
    AND lc.created_at >= now() - make_interval(mins => p_window_minutes)
    AND (c.recovery_nudge_at IS NULL OR c.recovery_nudge_at < lc.created_at)
  ORDER BY lm.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.recovery_candidates(uuid, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recovery_candidates(uuid, integer, integer, integer) TO service_role;
