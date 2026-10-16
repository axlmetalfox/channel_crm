-- ============================================================
-- 047_pending_conversations.sql — mark conversations that wait on the
-- customer as Pending
--
-- An open conversation whose last message is ours (the bot or an agent)
-- and that the customer has not answered for p_minutes is waiting on the
-- customer: it becomes 'pending'. A customer message re-opens it (done in
-- the inbound code, see reopenClosedConversation). Called every few
-- minutes by the cron route /api/conversations/sweep; returns how many
-- conversations changed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_pending_conversations(p_minutes integer DEFAULT 30)
RETURNS integer AS $$
  WITH stale AS (
    SELECT c.id
    FROM conversations c
    WHERE c.status = 'open'
      AND c.last_message_at IS NOT NULL
      AND c.last_message_at < now() - make_interval(mins => p_minutes)
      AND (
        SELECT m.sender_type
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) IN ('bot', 'agent')
  ), changed AS (
    UPDATE conversations
    SET status = 'pending', updated_at = now()
    WHERE id IN (SELECT id FROM stale)
      AND status = 'open'
    RETURNING 1
  )
  SELECT count(*)::integer FROM changed;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the cron route (service role) calls it.
REVOKE ALL ON FUNCTION public.mark_pending_conversations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_pending_conversations(integer) TO service_role;
