-- ============================================================
-- 062_scheduled_assignment.sql — one-time scheduled assignment
--
-- An admin can schedule a single moment at which every open or pending
-- conversation that meets the inactivity rule is handed out, equally, among
-- the available agents (round robin) — instead of the gradual trickle of the
-- recurring rule. The 5-minute sweep runs it once the time arrives.
--
--   accounts.auto_assign_once_at      when to run (null = nothing scheduled);
--                                     cleared as soon as the run starts
--   accounts.auto_assign_once_result  what the last scheduled run did
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_assign_once_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_assign_once_result jsonb;

COMMENT ON COLUMN accounts.auto_assign_once_at IS
  'When to hand out all stalled conversations equally, once. Cleared when the run starts.';
COMMENT ON COLUMN accounts.auto_assign_once_result IS
  'Outcome of the last scheduled run: { ran_at, assigned, per_agent: { user_id: count }, error? }.';
