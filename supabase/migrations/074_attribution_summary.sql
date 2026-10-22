-- ============================================================
-- 074_attribution_summary.sql — where the conversations come from
--
-- Feeds the dashboard card "Fuentes de Atribución": for the conversations
-- created in a date range, grouped by the Meta ad / post that started them
-- (conversations.attribution, filled from the click-to-WhatsApp referral):
-- how many conversations, and how many ended with a lead delivered to the
-- CRM (a delivered lead_intakes row). Conversations without attribution are
-- one row with source_type 'direct'.
--
-- SECURITY INVOKER: row-level security applies, so each person only counts
-- the conversations she may open (the card itself is shown to admins, the
-- owner and observers). Signed-in members only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.attribution_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  source_type text,
  source_id text,
  headline text,
  media_type text,
  source_url text,
  conversations bigint,
  leads bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(c.attribution->>'source_type', 'direct') AS source_type,
    c.attribution->>'source_id' AS source_id,
    max(c.attribution->>'headline') AS headline,
    max(c.attribution->>'media_type') AS media_type,
    max(c.attribution->>'source_url') AS source_url,
    count(*) AS conversations,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM lead_intakes li
        WHERE li.conversation_id = c.id AND li.status = 'delivered'
      )
    ) AS leads
  FROM conversations c
  WHERE c.created_at >= p_from AND c.created_at < p_to
  GROUP BY 1, 2
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.attribution_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attribution_summary(timestamptz, timestamptz) TO authenticated, service_role;
