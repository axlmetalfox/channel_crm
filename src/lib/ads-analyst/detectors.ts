import { formatCurrency, formatNumber } from '../currency'
import type {
  AdSnapshot,
  Evidence,
  Finding,
  FindingCode,
  FindingType,
  Metrics,
  Severity,
  Snapshot,
} from './types'

// ============================================================
// Rule-based detectors: deterministic, no model.
//
// Each rule has a minimum sample so a small number never becomes a verdict;
// when the sample is too small the answer is "wait" (D9), not a guess. The
// thresholds are starting values to calibrate against the account's own
// history (see the backtest in the design doc).
// ============================================================

export interface Thresholds {
  /** An ad younger than this many days is not judged. */
  minAdAgeDays: number
  /** D1: spend, in multiples of the account's cost per conversation, with no chats. */
  noResultsSpendFactor: number
  /** D2/D3 need at least this many leads on the ad. */
  minLeads: number
  /** D2: cost per lead above this multiple of the account's. */
  highCostFactor: number
  /** D3: cost per lead at or below this multiple, on an ad with a small share of the spend. */
  efficientCostFactor: number
  efficientMaxSpendShare: number
  /** D4: minimum chats, and the lead rate relative to the account's below which it is flagged. */
  minChatsForLeadRate: number
  lowLeadRateFactor: number
  /** D5: minimum chats in both windows, cost increase and the spend band that counts as "similar". */
  minChatsForTrend: number
  trendIncrease: number
  similarSpendBand: number
  /** D7: minimum chats (the larger count) and the relative gap. */
  minChatsForGap: number
  measurementGap: number
  /** D8: share of the account's spend. */
  concentratedShare: number
  /** D9: share of spend above which an unproven ad is worth a note. */
  waitMinSpendShare: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minAdAgeDays: 4,
  noResultsSpendFactor: 2,
  minLeads: 5,
  highCostFactor: 1.5,
  efficientCostFactor: 0.7,
  efficientMaxSpendShare: 0.15,
  minChatsForLeadRate: 20,
  lowLeadRateFactor: 0.5,
  minChatsForTrend: 10,
  trendIncrease: 0.3,
  similarSpendBand: 0.25,
  minChatsForGap: 20,
  measurementGap: 0.3,
  concentratedShare: 0.4,
  waitMinSpendShare: 0.05,
}

const TYPE_OF: Record<FindingCode, FindingType> = {
  D1: 'gasto_sin_resultados',
  D2: 'costo_alto',
  D3: 'eficiente_poco_presupuesto',
  D4: 'chats_no_convierten',
  D5: 'deterioro_tendencia',
  D6: 'titular_repetido',
  D7: 'brecha_medicion',
  D8: 'gasto_concentrado',
  D9: 'datos_insuficientes',
}

interface Refs {
  currency: string
  spend: number
  /** The account's cost per conversation / lead / lead rate, from ads only. */
  costPerConversation: number | null
  costPerLead: number | null
  leadRate: number | null
}

function refsOf(s: Snapshot): Refs {
  const a: Metrics = s.account.current
  return {
    currency: s.currency,
    spend: a.spend,
    costPerConversation: a.costPerConversation,
    costPerLead: a.costPerLead,
    leadRate: a.leadRate,
  }
}

const money = (value: number, currency: string) => formatCurrency(Math.round(value), currency)
const pct = (r: number) => `${formatNumber(r * 100, 0)} %`
const label = (a: AdSnapshot) => a.headline || a.name || `Anuncio ${a.id}`

function severityFor(amount: number, accountSpend: number): Severity {
  const share = accountSpend > 0 ? amount / accountSpend : 0
  return share >= 0.1 ? 'alta' : share >= 0.03 ? 'media' : 'baja'
}

function make(
  code: FindingCode,
  entity: Finding['entity'],
  amount: number,
  refs: Refs,
  evidence: Evidence[],
  summary: string,
  severity?: Severity,
): Finding {
  return {
    code,
    type: TYPE_OF[code],
    fingerprint: `${TYPE_OF[code]}:${entity.type}:${entity.id}`,
    entity,
    severity: severity ?? severityFor(amount, refs.spend),
    money: Math.max(0, Math.round(amount)),
    evidence,
    summary,
  }
}

const adEntity = (a: AdSnapshot): Finding['entity'] => ({ type: 'anuncio', id: a.id, name: label(a), status: a.status })

/** Old enough to be judged. */
function oldEnough(a: AdSnapshot, t: Thresholds): boolean {
  return (a.ageDays ?? 0) >= t.minAdAgeDays
}

/** Delivering now, so there is still something to do about it. */
const isActive = (a: AdSnapshot) => a.status === 'active'

/** Said of an ad that already stopped: the finding is a lesson, not an action. */
const pausedNote = (a: AdSnapshot) => (isActive(a) ? '' : ' (ya está pausado: sirve como lección, no como acción)')

export function detectFindings(snapshot: Snapshot, thresholds: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const t = thresholds
  const refs = refsOf(snapshot)
  const cur = (a: AdSnapshot) => a.current
  const findings: Finding[] = []
  const flagged = new Set<string>()
  const cop = (v: number) => money(v, refs.currency)

  for (const a of snapshot.ads) {
    if (!oldEnough(a, t)) continue
    const m = cur(a)

    // D1 — spent a lot and brought no chats (only worth saying while it still runs).
    if (
      isActive(a) &&
      refs.costPerConversation !== null &&
      m.conversations === 0 &&
      m.spend >= t.noResultsSpendFactor * refs.costPerConversation
    ) {
      flagged.add(a.id)
      findings.push(
        make(
          'D1',
          adEntity(a),
          m.spend,
          refs,
          [
            { metric: 'gasto', value: m.spend, unit: 'cop' },
            { metric: 'conversaciones', value: 0, unit: 'count' },
            { metric: 'costo_por_conversacion_cuenta', value: refs.costPerConversation, unit: 'cop' },
            { metric: 'dias_activo', value: a.ageDays ?? 0, unit: 'days' },
          ],
          `«${label(a)}» gastó ${cop(m.spend)} en ${snapshot.windows.days} días y no trajo ninguna conversación (cada conversación cuesta ${cop(refs.costPerConversation)} en promedio en la cuenta).`,
        ),
      )
      continue
    }

    // D2 / D3 — cost per lead against the account's.
    if (m.leads >= t.minLeads && m.costPerLead !== null && refs.costPerLead !== null) {
      if (m.costPerLead > t.highCostFactor * refs.costPerLead) {
        flagged.add(a.id)
        findings.push(
          make(
            'D2',
            adEntity(a),
            (m.costPerLead - refs.costPerLead) * m.leads,
            refs,
            [
              { metric: 'costo_por_lead', value: m.costPerLead, reference: refs.costPerLead, unit: 'cop' },
              { metric: 'leads', value: m.leads, unit: 'count' },
              { metric: 'gasto', value: m.spend, unit: 'cop' },
            ],
            `«${label(a)}» cuesta ${cop(m.costPerLead)} por lead, ${formatNumber(m.costPerLead / refs.costPerLead, 1)} veces el promedio de la cuenta (${cop(refs.costPerLead)}), con ${formatNumber(m.leads)} leads${pausedNote(a)}.`,
          ),
        )
      } else if (
        isActive(a) &&
        m.costPerLead <= t.efficientCostFactor * refs.costPerLead &&
        refs.spend > 0 &&
        m.spend / refs.spend < t.efficientMaxSpendShare
      ) {
        findings.push(
          make(
            'D3',
            adEntity(a),
            (refs.costPerLead - m.costPerLead) * m.leads,
            refs,
            [
              { metric: 'costo_por_lead', value: m.costPerLead, reference: refs.costPerLead, unit: 'cop' },
              { metric: 'leads', value: m.leads, unit: 'count' },
              { metric: 'participacion_del_gasto', value: m.spend / refs.spend, unit: 'ratio' },
            ],
            `«${label(a)}» trae leads a ${cop(m.costPerLead)}, bastante por debajo del promedio (${cop(refs.costPerLead)}), y solo recibe el ${pct(m.spend / refs.spend)} del gasto.`,
            'media',
          ),
        )
      }
    }

    // D4 — plenty of chats, few of them become leads.
    if (m.conversations >= t.minChatsForLeadRate && m.leadRate !== null && refs.leadRate !== null && refs.leadRate > 0) {
      if (m.leadRate < t.lowLeadRateFactor * refs.leadRate) {
        flagged.add(a.id)
        findings.push(
          make(
            'D4',
            adEntity(a),
            m.spend * (1 - m.leadRate / refs.leadRate),
            refs,
            [
              { metric: 'tasa_chat_a_lead', value: m.leadRate, reference: refs.leadRate, unit: 'ratio' },
              { metric: 'conversaciones', value: m.conversations, unit: 'count' },
              { metric: 'gasto', value: m.spend, unit: 'cop' },
            ],
            `«${label(a)}» trae ${formatNumber(m.conversations)} conversaciones pero solo el ${pct(m.leadRate)} termina en lead (en la cuenta, el ${pct(refs.leadRate)}): el tráfico llega pero no califica${pausedNote(a)}.`,
          ),
        )
      }
    }

    // D5 — cost per chat climbing at similar spend.
    const p = a.previous
    if (
      snapshot.coverage.previousComplete &&
      m.conversations >= t.minChatsForTrend &&
      p.conversations >= t.minChatsForTrend &&
      m.costPerConversation !== null &&
      p.costPerConversation !== null &&
      p.spend > 0 &&
      Math.abs(m.spend - p.spend) / p.spend <= t.similarSpendBand &&
      m.costPerConversation >= p.costPerConversation * (1 + t.trendIncrease)
    ) {
      flagged.add(a.id)
      findings.push(
        make(
          'D5',
          adEntity(a),
          (m.costPerConversation - p.costPerConversation) * m.conversations,
          refs,
          [
            { metric: 'costo_por_conversacion', value: m.costPerConversation, reference: p.costPerConversation, unit: 'cop' },
            { metric: 'gasto', value: m.spend, reference: p.spend, unit: 'cop' },
            { metric: 'conversaciones', value: m.conversations, reference: p.conversations, unit: 'count' },
          ],
          `«${label(a)}» pasó de ${cop(p.costPerConversation)} a ${cop(m.costPerConversation)} por conversación (+${pct(m.costPerConversation / p.costPerConversation - 1)}) con un gasto parecido${pausedNote(a)}.`,
        ),
      )
    }
  }

  // D6 — the same headline running in several ad sets.
  const byHeadline = new Map<string, AdSnapshot[]>()
  for (const a of snapshot.ads) {
    if (a.status !== 'active' || a.current.spend <= 0 || !a.headline) continue
    const key = a.headline.trim().toLowerCase()
    byHeadline.set(key, [...(byHeadline.get(key) ?? []), a])
  }
  for (const [, group] of byHeadline) {
    const sets = new Set(group.map((a) => a.adSetName ?? a.id))
    if (group.length < 2 || sets.size < 2) continue
    const spend = group.reduce((n, a) => n + a.current.spend, 0)
    const first = group[0]
    findings.push(
      make(
        'D6',
        { type: 'grupo', id: group.map((a) => a.id).sort().join(','), name: label(first) },
        spend,
        refs,
        [
          { metric: 'anuncios_con_el_mismo_titular', value: group.length, unit: 'count' },
          { metric: 'conjuntos_distintos', value: sets.size, unit: 'count' },
          { metric: 'gasto', value: spend, unit: 'cop' },
        ],
        `El titular «${label(first)}» corre en ${group.length} anuncios de ${sets.size} conjuntos distintos (${cop(spend)} en total): pueden estar compitiendo por la misma audiencia.`,
        'baja',
      ),
    )
  }

  // D7 — the ad platform says far more chats started than TUYO received. Either
  // they happen somewhere else (another number, a form, Messenger), or they
  // never write, or the measurement fails: in all three the spend is not
  // showing up as chats here. Money at stake = the spend the gap represents.
  for (const c of snapshot.campaigns) {
    const meta = c.current.platformConversations
    const ours = c.current.conversations
    const bigger = Math.max(meta, ours)
    if (bigger < t.minChatsForGap) continue
    const gap = Math.abs(meta - ours) / bigger
    if (gap <= t.measurementGap) continue
    const name = c.name ?? `Campaña ${c.id}`
    findings.push(
      make(
        'D7',
        { type: 'campaña', id: c.id, name },
        meta > ours ? c.current.spend * gap : 0,
        refs,
        [
          { metric: 'conversaciones_segun_meta', value: meta, reference: ours, unit: 'count' },
          { metric: 'diferencia', value: gap, unit: 'ratio' },
          { metric: 'gasto', value: c.current.spend, unit: 'cop' },
        ],
        `En «${name}» Meta cuenta ${formatNumber(meta)} conversaciones y TUYO ${formatNumber(ours)} (${pct(gap)} de diferencia, con ${cop(c.current.spend)} de gasto): conviene revisar a dónde llegan esos chats antes de decidir con estos costos.`,
        'media',
      ),
    )
  }

  // D8 — one ad carries the account.
  for (const a of snapshot.ads) {
    if (refs.spend <= 0) break
    if (!isActive(a)) continue
    const share = a.current.spend / refs.spend
    if (share > t.concentratedShare) {
      findings.push(
        make(
          'D8',
          adEntity(a),
          0,
          refs,
          [
            { metric: 'participacion_del_gasto', value: share, unit: 'ratio' },
            { metric: 'gasto', value: a.current.spend, unit: 'cop' },
          ],
          `«${label(a)}» concentra el ${pct(share)} del gasto de la cuenta: si falla, falla todo.`,
          'baja',
        ),
      )
    }
  }

  // D9 — spending real money on an ad we cannot judge yet.
  for (const a of snapshot.ads) {
    if (!isActive(a) || !oldEnough(a, t) || flagged.has(a.id) || refs.spend <= 0) continue
    const m = a.current
    const share = m.spend / refs.spend
    const enough = m.leads >= t.minLeads && m.conversations >= t.minChatsForLeadRate
    if (share >= t.waitMinSpendShare && !enough && findings.every((f) => f.fingerprint !== `${TYPE_OF.D3}:anuncio:${a.id}`)) {
      findings.push(
        make(
          'D9',
          adEntity(a),
          0,
          refs,
          [
            { metric: 'leads', value: m.leads, unit: 'count' },
            { metric: 'conversaciones', value: m.conversations, unit: 'count' },
            { metric: 'participacion_del_gasto', value: share, unit: 'ratio' },
          ],
          `«${label(a)}» lleva el ${pct(share)} del gasto pero solo tiene ${formatNumber(m.conversations)} conversaciones y ${formatNumber(m.leads)} leads: todavía no hay datos para juzgarlo.`,
          'baja',
        ),
      )
    }
  }

  const rank = { alta: 0, media: 1, baja: 2 } as const
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.money - a.money)
}
