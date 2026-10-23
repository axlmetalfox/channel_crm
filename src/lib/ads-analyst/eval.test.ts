import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { ANALYST_SCHEMA, SYSTEM_PROMPT, buildAnalystInput, validateAnalysis, type AnalystContext } from './analyst'
import { detectFindings } from './detectors'
import { BASE, snapshotOf } from './fixtures'
import { buildSnapshot } from './snapshot'
import type { Finding, Snapshot } from './types'

/**
 * Manual model evaluation, skipped in the normal run. Two steps:
 *
 * 1. Dump the request for the candidate models (real account export + a
 *    synthetic account with more findings):
 *      ADS_EVAL_MODE=dump ADS_PREVIEW_FILE=export.json ADS_EVAL_FILE=request.json \
 *        npx vitest run src/lib/ads-analyst/eval.test.ts
 *    Send it to the router with the script that reads request.json and writes results.json.
 *
 * 2. Score what came back (validation, figures, retries needed, tokens, credits):
 *      ADS_EVAL_MODE=score ADS_PREVIEW_FILE=export.json ADS_EVAL_FILE=results.json \
 *        npx vitest run src/lib/ads-analyst/eval.test.ts --disable-console-intercept
 */
const mode = process.env.ADS_EVAL_MODE
const exportFile = process.env.ADS_PREVIEW_FILE
const evalFile = process.env.ADS_EVAL_FILE

const CONTEXT: AnalystContext = {
  business:
    'Intertec vende máquinas empacadoras, selladoras y envasadoras industriales, principalmente en Colombia. Los clientes llegan por anuncios de Meta que abren un chat de WhatsApp; un agente de IA hace una entrevista, el lead se envía a Zoho y un asesor comercial lo atiende. Los anuncios pausados suelen ser creativos que ya se probaron.',
  goal: 'Conseguir leads calificados al menor costo por lead posible.',
  previous: [],
}

interface Scenario {
  name: string
  snapshot: Snapshot
  findings: Finding[]
}

function scenarios(): Scenario[] {
  const out: Scenario[] = []
  if (exportFile) {
    const raw = JSON.parse(readFileSync(exportFile, 'utf-8'))
    const snapshot = buildSnapshot({
      today: raw.today,
      catalog: raw.catalog,
      daily: raw.daily,
      attribution: { current: raw.current, previous: raw.previous },
      attributionSince: raw.attributionSince ?? null,
    })
    out.push({ name: 'real', snapshot, findings: detectFindings(snapshot) })
  }
  const synthetic = snapshotOf([
    ...BASE,
    { id: 'bad', chats: 0 },
    { id: 'dear', spend: 40000, chats: 28, leads: 7 },
    { id: 'cold', chats: 40, leads: 2 },
    { id: 'cheap', spend: 3000, chats: 28, leads: 7 },
    { id: 'gone', spend: 40000, chats: 28, leads: 7, catalog: { status: 'paused' } },
    { id: 'x1', headline: 'Máquinas en stock', chats: 28, leads: 7 },
    { id: 'x2', headline: 'máquinas en stock', chats: 28, leads: 7 },
    { id: 'wait', chats: 6, leads: 1 },
  ])
  out.push({ name: 'sintetico', snapshot: synthetic, findings: detectFindings(synthetic) })
  return out
}

describe.skipIf(!mode || !evalFile)('ads analyst model evaluation', () => {
  it('dumps or scores', () => {
    const list = scenarios()
    if (mode === 'dump') {
      writeFileSync(
        evalFile as string,
        JSON.stringify({
          systemPrompt: SYSTEM_PROMPT,
          schema: ANALYST_SCHEMA,
          scenarios: list.map((s) => ({ name: s.name, user: buildAnalystInput(s.snapshot, s.findings, CONTEXT) })),
        }),
      )
      console.log(`request written: ${list.map((s) => `${s.name} (${s.findings.length} hallazgos)`).join(', ')}`)
      return
    }

    interface Row { model: string; scenario: string; ok: boolean; error?: string; text?: string; ms: number; usage?: { prompt_tokens?: number; completion_tokens?: number; credits_charged?: number } }
    const results = JSON.parse(readFileSync(evalFile as string, 'utf-8')) as { results: Row[] }
    const lines: string[] = []
    for (const row of results.results) {
      const sc = list.find((s) => s.name === row.scenario)!
      const head = `${row.model.padEnd(24)} ${row.scenario.padEnd(9)} ${String(Math.round(row.ms / 1000)).padStart(3)}s`
      const usage = `tok ${row.usage?.prompt_tokens ?? '?'}/${row.usage?.completion_tokens ?? '?'} cred ${row.usage?.credits_charged ?? '?'}`
      if (!row.ok || !row.text) {
        lines.push(`${head}  FALLA del proveedor: ${(row.error ?? '').slice(0, 140)}`)
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(row.text)
      } catch {
        lines.push(`${head}  JSON inválido | ${usage}`)
        continue
      }
      const v = validateAnalysis(parsed, sc.snapshot, sc.findings)
      const recs = v.recommendations.filter((r) => r.source === 'modelo').length
      lines.push(
        `${head}  ${v.errors.length === 0 ? 'VÁLIDA' : `RECHAZADA (${v.errors.length})`} | recs ${recs}/${sc.findings.length} hallazgos | avisos ${v.warnings.length} | ${usage}`,
      )
      for (const e of v.errors.slice(0, 4)) lines.push(`      - ${e.slice(0, 170)}`)
    }
    console.log(lines.join('\n'))
  })
})
