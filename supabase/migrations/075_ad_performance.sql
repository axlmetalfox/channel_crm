-- ============================================================
-- 075_ad_performance.sql — ad names and daily spend for the attribution card
--
-- The click-to-WhatsApp referral only carries the ad id and its headline.
-- To show the campaign, the ad set and what each one cost, the server copies
-- from the connected ad account (Meta Ads, through the connection service):
--   ad_catalog         one row per ad: name, campaign, ad set, status
--   ad_insights_daily  one row per ad per day: spend, impressions, clicks and
--                      the conversations Meta says were started
--   ad_sync_state      when each account was last synced (and why it failed)
--
-- Only the server (service role) writes them. Admins, the owner and observers
-- read them (the same people who see the Attribution card); advisors do not.
--
-- ad_performance_summary(p_from, p_to) returns every ad of the catalog with what
-- it spent in the range (zero when nothing).
-- SECURITY INVOKER: row-level security applies.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ad_catalog (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform_ad_id text NOT NULL,
  ad_name text,
  campaign_id text,
  campaign_name text,
  adset_id text,
  adset_name text,
  status text,
  currency text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, platform_ad_id)
);

CREATE TABLE IF NOT EXISTS ad_insights_daily (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform_ad_id text NOT NULL,
  day date NOT NULL,
  spend numeric(14, 2) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  conversations_started bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, platform_ad_id, day)
);

CREATE INDEX IF NOT EXISTS ad_insights_daily_day_idx ON ad_insights_daily (account_id, day);

CREATE TABLE IF NOT EXISTS ad_sync_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_synced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  ads_count integer NOT NULL DEFAULT 0,
  rows_count integer NOT NULL DEFAULT 0
);

ALTER TABLE ad_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_insights_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_sync_state ENABLE ROW LEVEL SECURITY;

-- Admin / owner, or a member below the agent role (the observer).
DROP POLICY IF EXISTS ad_catalog_select ON ad_catalog;
CREATE POLICY ad_catalog_select ON ad_catalog FOR SELECT
  USING (is_account_member(account_id, 'admin')
         OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent')));

DROP POLICY IF EXISTS ad_insights_daily_select ON ad_insights_daily;
CREATE POLICY ad_insights_daily_select ON ad_insights_daily FOR SELECT
  USING (is_account_member(account_id, 'admin')
         OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent')));

DROP POLICY IF EXISTS ad_sync_state_select ON ad_sync_state;
CREATE POLICY ad_sync_state_select ON ad_sync_state FOR SELECT
  USING (is_account_member(account_id, 'admin')
         OR (is_account_member(account_id) AND NOT is_account_member(account_id, 'agent')));

REVOKE ALL ON ad_catalog, ad_insights_daily, ad_sync_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON ad_catalog, ad_insights_daily, ad_sync_state TO authenticated;
GRANT ALL ON ad_catalog, ad_insights_daily, ad_sync_state TO service_role;

CREATE OR REPLACE FUNCTION public.ad_performance_summary(p_from date, p_to date)
RETURNS TABLE (
  platform_ad_id text,
  ad_name text,
  campaign_id text,
  campaign_name text,
  adset_name text,
  status text,
  currency text,
  spend numeric,
  impressions bigint,
  clicks bigint,
  meta_conversations bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    coalesce(c.platform_ad_id, d.platform_ad_id),
    c.ad_name,
    c.campaign_id,
    c.campaign_name,
    c.adset_name,
    c.status,
    c.currency,
    coalesce(d.spend, 0),
    coalesce(d.impressions, 0)::bigint,
    coalesce(d.clicks, 0)::bigint,
    coalesce(d.conversations_started, 0)::bigint
  FROM ad_catalog c
  FULL OUTER JOIN (
    SELECT account_id, platform_ad_id,
           sum(spend) AS spend,
           sum(impressions) AS impressions,
           sum(clicks) AS clicks,
           sum(conversations_started) AS conversations_started
    FROM ad_insights_daily
    WHERE day >= p_from AND day <= p_to
    GROUP BY account_id, platform_ad_id
  ) d ON d.account_id = c.account_id AND d.platform_ad_id = c.platform_ad_id
  ORDER BY coalesce(d.spend, 0) DESC, coalesce(c.platform_ad_id, d.platform_ad_id);
$$;

REVOKE ALL ON FUNCTION public.ad_performance_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ad_performance_summary(date, date) TO authenticated, service_role;
