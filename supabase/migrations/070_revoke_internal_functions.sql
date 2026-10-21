-- ============================================================
-- 070_revoke_internal_functions.sql — internal helpers are not public API
--
-- Supabase grants EXECUTE on every new function in `public` to the `anon` and
-- `authenticated` roles, and `REVOKE ... FROM PUBLIC` does not take those
-- grants away. Several SECURITY DEFINER helpers that only the server (service
-- role) is meant to run were therefore callable through the REST API by
-- anyone holding the public anon key, without any check of who is calling:
--
--   mark_pending_conversations   turns every old open conversation to pending
--   claim_ai_reply_slot          burns the AI reply budget of any conversation
--   record_webhook_failure       can disable a webhook endpoint (lead delivery)
--   recovery_candidates          lists conversations of any account
--   merge_duplicate_contacts / merge_duplicate_conversations   rewrite data
--
-- They are revoked from anon and authenticated by name; the service role (the
-- server) keeps EXECUTE. The two broadcast counter helpers are used by
-- triggers that may run as the signed-in user, so only anon loses them.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

REVOKE ALL ON FUNCTION public.mark_pending_conversations(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_pending_conversations(integer) TO service_role;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.recovery_candidates(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recovery_candidates(uuid, integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO service_role;

REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_conversations() TO service_role;

-- Broadcast counters: triggers call them; signed-out visitors never need them.
REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon;

-- Functions that check the caller themselves are for signed-in people only.
REVOKE ALL ON FUNCTION public.block_contact(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unblock_contact(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_stage_automation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_conversation(uuid, uuid) FROM PUBLIC, anon;
