// ============================================================
// Ads analyst — shared types.
//
// Phase 1 is read-only: a snapshot of the ad account (this file's Snapshot),
// rule-based detectors that turn it into Findings, and later a model that
// ranks and explains them. Everything here is plain data: no database, no
// network, so it is easy to test and to replay on past dates.
// ============================================================

/** Inclusive calendar days, YYYY-MM-DD (Bogotá). */
export interface WindowRange {
  from: string
  to: string
}

export interface Windows {
  /** Days in each window. */
  days: number
  current: WindowRange
  previous: WindowRange
}

/** One ad of the catalog (ad_catalog). */
export interface CatalogAd {
  platform_ad_id: string
  ad_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_name: string | null
  status: string | null
  currency: string | null
}

/** One ad on one day (ad_insights_daily). */
export interface DailyRow {
  platform_ad_id: string
  day: string
  spend: number | string
  impressions: number | string
  clicks: number | string
  conversations_started: number | string
}

/** Conversations and leads per ad in a window (attribution_summary rows). */
export interface AttributionInput {
  source_type: string
  source_id: string | null
  headline: string | null
  conversations: number | string
  leads: number | string
}

export interface SnapshotInput {
  /** Today, YYYY-MM-DD (Bogotá). The windows end yesterday: today is incomplete. */
  today: string
  days?: number
  catalog: CatalogAd[]
  daily: DailyRow[]
  attribution: { current: AttributionInput[]; previous: AttributionInput[] }
  /**
   * First day TUYO recorded the ad a chat came from. Before it, a chat with no
   * ad would look like an ad that brought none, so spend before this day is
   * left out of both windows. Omit when the history is complete.
   */
  attributionSince?: string | null
}

export interface Metrics {
  spend: number
  impressions: number
  clicks: number
  /** Conversations the ad platform says it started. */
  platformConversations: number
  /** Conversations TUYO attributes to the ad (the click referral). */
  conversations: number
  /** Conversations that ended with a lead delivered to the CRM. */
  leads: number
  /** Days of the window with spend. */
  spendDays: number
  costPerConversation: number | null
  costPerLead: number | null
  /** leads / conversations. */
  leadRate: number | null
}

export interface AdSnapshot {
  id: string
  name: string | null
  headline: string | null
  campaignId: string | null
  campaignName: string | null
  adSetName: string | null
  status: string | null
  /** First day with spend we know of (the history we keep is ~90 days). */
  firstSpendDay: string | null
  /** Days since the first spend, up to the end of the window. */
  ageDays: number | null
  current: Metrics
  previous: Metrics
}

export interface CampaignSnapshot {
  id: string
  name: string | null
  /** 'active' when any of its ads is. */
  status: string | null
  adCount: number
  current: Metrics
  previous: Metrics
}

/** How much of each window the numbers really cover. */
export interface Coverage {
  attributionSince: string | null
  /** Days of the current window that count (less than `windows.days` when attribution is recent). */
  currentDays: number
  previousDays: number
  /** The previous window is fully covered, so the two periods can be compared. */
  previousComplete: boolean
}

export interface Snapshot {
  windows: Windows
  coverage: Coverage
  currency: string
  account: {
    current: Metrics
    previous: Metrics
    /** Conversations that came without an ad. */
    directConversations: { current: number; previous: number }
  }
  campaigns: CampaignSnapshot[]
  ads: AdSnapshot[]
}

// ---- Findings ---------------------------------------------------------------

export type FindingCode = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9'

export type FindingType =
  | 'gasto_sin_resultados'
  | 'costo_alto'
  | 'eficiente_poco_presupuesto'
  | 'chats_no_convierten'
  | 'deterioro_tendencia'
  | 'titular_repetido'
  | 'brecha_medicion'
  | 'gasto_concentrado'
  | 'datos_insuficientes'

export type EntityType = 'anuncio' | 'campaña' | 'cuenta' | 'grupo'

export interface Evidence {
  metric: string
  value: number
  /** What it is compared with (the account's figure, the previous period...). */
  reference?: number
  unit: 'cop' | 'count' | 'ratio' | 'days'
}

export type Severity = 'alta' | 'media' | 'baja'

export interface Finding {
  code: FindingCode
  type: FindingType
  /** Stable across runs: type + entity. Tells a repeated finding from a new one. */
  fingerprint: string
  /** `status` is the ad's delivery status now: a paused ad is a lesson, not an action. */
  entity: { type: EntityType; id: string; name: string; status?: string | null }
  severity: Severity
  /** Money at stake, in the account's currency (0 when it is not about money). */
  money: number
  evidence: Evidence[]
  /** Plain-Spanish sentence built from the numbers; the fallback text when no model writes it. */
  summary: string
}
