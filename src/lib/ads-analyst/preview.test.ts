import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { detectFindings } from './detectors'
import { buildSnapshot } from './snapshot'
import { formatCurrency, formatNumber } from '../currency'

/**
 * Manual preview, skipped in the normal run. Replays the analysis on a JSON
 * export of the account (catalog, daily numbers, attributed chats):
 *
 *   ADS_PREVIEW_FILE=/path/export.json npx vitest run src/lib/ads-analyst/preview.test.ts
 *
 * Prints the snapshot totals and the findings to the console.
 */
const file = process.env.ADS_PREVIEW_FILE

describe.skipIf(!file)('ads analyst preview', () => {
  it('prints the findings', () => {
    const raw = JSON.parse(readFileSync(file as string, 'utf-8'))
    const snap = buildSnapshot({
      today: raw.today,
      catalog: raw.catalog,
      daily: raw.daily,
      attribution: { current: raw.current, previous: raw.previous },
      attributionSince: raw.attributionSince ?? null,
    })
    const cop = (v: number | null) => (v === null ? '—' : formatCurrency(v, snap.currency))
    const a = snap.account.current
    const lines: string[] = []
    lines.push(`Ventana actual ${snap.windows.current.from}..${snap.windows.current.to} | previa ${snap.windows.previous.from}..${snap.windows.previous.to}`)
    lines.push(
      `Cuenta (actual): gasto ${cop(a.spend)} | conversaciones ${a.conversations} | leads ${a.leads} | costo/conv ${cop(a.costPerConversation)} | costo/lead ${cop(a.costPerLead)} | chat->lead ${a.leadRate === null ? '—' : formatNumber(a.leadRate * 100, 1) + ' %'}`,
    )
    const p = snap.account.previous
    lines.push(
      `Cuenta (previa): gasto ${cop(p.spend)} | conversaciones ${p.conversations} | leads ${p.leads} | costo/conv ${cop(p.costPerConversation)} | costo/lead ${cop(p.costPerLead)}`,
    )
    const cov = snap.coverage
    lines.push(
      `Cobertura: atribución desde ${cov.attributionSince ?? 'siempre'} | días actual ${cov.currentDays}/${snap.windows.days} | previa ${cov.previousDays}/${snap.windows.days} (${cov.previousComplete ? 'comparable' : 'NO comparable'})`,
    )
    lines.push(`Anuncios con actividad: ${snap.ads.length} | campañas: ${snap.campaigns.length} | directas: ${snap.account.directConversations.current}`)
    lines.push('', 'Top anuncios por gasto (actual):')
    for (const ad of snap.ads.slice(0, 12)) {
      const m = ad.current
      lines.push(
        `  ${(ad.headline ?? ad.name ?? ad.id).slice(0, 38).padEnd(38)} ${String(ad.status).padEnd(8)} ${String(ad.ageDays ?? '?').padStart(3)}d  gasto ${cop(m.spend).padStart(11)}  chats ${String(m.conversations).padStart(3)}  leads ${String(m.leads).padStart(3)}  $/lead ${cop(m.costPerLead)}`,
      )
    }
    const findings = detectFindings(snap)
    lines.push(`\nHallazgos: ${findings.length}`)
    for (const f of findings) {
      lines.push(`[${f.severity}] ${f.code} ${f.entity.type} | ${cop(f.money)} en juego\n   ${f.summary}`)
    }
    console.log(lines.join('\n'))
  })
})
