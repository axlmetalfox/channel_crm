import type { Finding, Snapshot } from './types'

// ============================================================
// "Every figure the model writes must come from the data."
//
// The model explains; it does not calculate. Before a recommendation is kept,
// each number in its text is looked up among the figures we gave it (and the
// ones that follow directly from them: a percentage, a ratio, a difference).
// A figure with no source rejects the recommendation.
// ============================================================

const WORDS: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
}

/** Remove what looks like a number but is a name, a date or an id. */
function stripNonFigures(text: string): string {
  return text
    .replace(/«[^»]*»/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, ' ')
    .replace(/\bID\s*\d+\b/gi, ' ')
    .replace(/\b\d{9,}\b/g, ' ')
}

/** "77.830" -> 77830, "1,5" -> 1.5, "1.234,5" -> 1234.5 (es-CO). */
function parseFigure(token: string): number {
  const hasDot = token.includes('.')
  const hasComma = token.includes(',')
  let clean = token
  if (hasDot && hasComma) clean = token.replace(/\./g, '').replace(',', '.')
  else if (hasComma) clean = token.replace(',', '.')
  else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(token)) clean = token.replace(/\./g, '')
  return Number(clean)
}

/** Every figure in a text, with "mil" / "millones" applied and number words included. */
export function extractFigures(text: string): number[] {
  const body = stripNonFigures(text)
  const out: number[] = []
  const re = /\d+(?:[.,]\d+)*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    let n = parseFigure(m[0])
    if (!Number.isFinite(n)) continue
    const rest = body.slice(m.index + m[0].length, m.index + m[0].length + 14).toLowerCase()
    if (/^\s*(millones|millón|millon)\b/.test(rest)) n *= 1_000_000
    else if (/^\s*(mil)\b/.test(rest)) n *= 1_000
    out.push(n)
  }
  for (const [word, value] of Object.entries(WORDS)) {
    if (new RegExp(`(^|[^a-záéíóúñ])${word}([^a-záéíóúñ]|$)`, 'i').test(body)) out.push(value)
  }
  return out
}

function derived(a: number, b: number): number[] {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return []
  const out = [a - b, b - a]
  if (b !== 0) out.push(a / b, (a / b - 1) * 100, (1 - a / b) * 100)
  if (a !== 0) out.push(b / a)
  return out
}

function metricFigures(m: {
  spend: number; impressions: number; clicks: number; platformConversations: number
  conversations: number; leads: number; spendDays: number
  costPerConversation: number | null; costPerLead: number | null; leadRate: number | null
}): number[] {
  return [
    m.spend, m.impressions, m.clicks, m.platformConversations, m.conversations, m.leads, m.spendDays,
    m.costPerConversation ?? 0, m.costPerLead ?? 0, (m.leadRate ?? 0) * 100,
  ]
}

/** The figures a recommendation about these findings may cite. */
export function allowedFigures(snapshot: Snapshot, findings: Finding[]): number[] {
  const out: number[] = [
    // 0 and 1 are never an invented figure ("1 anuncio", "ninguna").
    0,
    1,
    snapshot.account.directConversations.current,
    snapshot.account.directConversations.previous,
    snapshot.windows.days,
    snapshot.coverage.currentDays,
    snapshot.coverage.previousDays,
    ...metricFigures(snapshot.account.current),
    ...metricFigures(snapshot.account.previous),
  ]
  for (const f of findings) {
    out.push(f.money)
    out.push(...extractFigures(f.summary))
    for (const e of f.evidence) {
      out.push(e.value)
      if (e.unit === 'ratio') out.push(e.value * 100)
      if (e.reference !== undefined) {
        out.push(e.reference)
        if (e.unit === 'ratio') out.push(e.reference * 100)
        out.push(...derived(e.value, e.reference))
        if (e.unit === 'ratio') out.push(...derived(e.value * 100, e.reference * 100))
      }
    }
    // The entity's own numbers, so the model can say how many chats or leads it had.
    const ad = snapshot.ads.find((a) => a.id === f.entity.id)
    if (ad) {
      out.push(...metricFigures(ad.current), ...metricFigures(ad.previous), ad.ageDays ?? 0)
    }
    const campaign = snapshot.campaigns.find((c) => c.id === f.entity.id)
    if (campaign) out.push(...metricFigures(campaign.current), ...metricFigures(campaign.previous), campaign.adCount)
  }
  return out
}

/** A figure is sourced when it is within rounding distance of an allowed one. */
export function isSourced(n: number, allowed: number[]): boolean {
  return allowed.some((a) => Math.abs(n - a) <= Math.max(0.5, Math.abs(a) * 0.015))
}

/** The figures in `text` that no source backs. */
export function unsourcedFigures(text: string, allowed: number[]): number[] {
  return extractFigures(text).filter((n) => !isSourced(n, allowed))
}
