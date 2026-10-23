import { describe, it, expect } from 'vitest'
import {
  ANALYST_SCHEMA,
  buildAnalystInput,
  confidenceCap,
  runAnalyst,
  templateAnalysis,
  validateAnalysis,
  type GenerateFn,
} from './analyst'
import { detectFindings } from './detectors'
import { BASE, snapshotOf } from './fixtures'

// An account with a clear problem (D1), a repeated headline (D6) and a lesson (D2, paused).
const snap = snapshotOf([
  ...BASE,
  { id: 'bad', chats: 0 },
  { id: 'gone', spend: 40000, chats: 28, leads: 7, catalog: { status: 'paused' } },
  { id: 'x1', headline: 'Máquinas en stock', chats: 28, leads: 7 },
  { id: 'x2', headline: 'máquinas en stock', chats: 28, leads: 7 },
])
const findings = detectFindings(snap)
const fp = (code: string) => findings.find((f) => f.code === code)!.fingerprint
const D1 = fp('D1')
const D2 = fp('D2')
const D6 = fp('D6')
const d1 = findings.find((f) => f.code === 'D1')!

const rec = (over: Record<string, unknown> = {}) => ({
  prioridad: 1,
  titulo: 'Revisar el anuncio que no trae chats',
  tipo_accion: 'revisar_o_pausar',
  hallazgos: [D1],
  razonamiento: `Gastó ${d1.money} en 14 días y no trajo conversaciones.`,
  efecto_esperado: null,
  confianza: 'alta',
  advertencias: [],
  ...over,
})
const answer = (recs: unknown[], resumen = 'Hay un anuncio que gasta sin traer chats.') => ({ resumen, recomendaciones: recs })

describe('validateAnalysis', () => {
  it('accepts a grounded answer and copies entity and evidence from the findings', () => {
    const v = validateAnalysis(answer([rec()]), snap, findings)
    expect(v.errors).toEqual([])
    const r = v.recommendations.find((x) => x.findings.includes(D1))!
    expect(r.entity).toMatchObject({ id: 'bad' })
    expect(r.evidence).toEqual(d1.evidence)
    expect(r.money).toBe(d1.money)
    expect(r.source).toBe('modelo')
  })

  it('rejects a figure that is not in the data', () => {
    const v = validateAnalysis(answer([rec({ razonamiento: 'Trajo 37 leads de empacadoras.' })]), snap, findings)
    expect(v.errors.join(' ')).toContain('37')
  })

  it('rejects an unknown fingerprint and an invalid action', () => {
    expect(validateAnalysis(answer([rec({ hallazgos: ['nada:anuncio:zzz'] })]), snap, findings).errors.join(' ')).toContain('no existe')
    expect(validateAnalysis(answer([rec({ tipo_accion: 'comprar_mas' })]), snap, findings).errors.join(' ')).toContain('no es válido')
  })

  it('rejects an action that does not fit the finding', () => {
    const v = validateAnalysis(answer([rec({ tipo_accion: 'duplicar_creativo' })]), snap, findings)
    expect(v.errors.join(' ')).toContain('no corresponde')
  })

  it('does not let a paused ad be paused or fed more budget', () => {
    const bad = validateAnalysis(answer([rec({ hallazgos: [D2], tipo_accion: 'redistribuir_presupuesto', razonamiento: 'Conviene mover presupuesto.' })]), snap, findings)
    expect(bad.errors.join(' ')).toContain('no corresponde')
    const ok = validateAnalysis(answer([rec({ hallazgos: [D2], tipo_accion: 'aprendizaje', razonamiento: 'Es una lección: no relanzarlo.' })]), snap, findings)
    expect(ok.errors).toEqual([])
  })

  it('lowers a confidence the sample does not support', () => {
    const v = validateAnalysis(answer([rec({ hallazgos: [D6], tipo_accion: 'consolidar', razonamiento: 'Conviene unir los anuncios repetidos.' })]), snap, findings)
    expect(v.errors).toEqual([])
    expect(v.recommendations.find((r) => r.findings.includes(D6))!.confidence).toBe('media')
    expect(v.warnings.join(' ')).toContain('se bajó')
  })

  it('lets the model recommend waiting on a non-critical finding, always with low confidence', () => {
    const v = validateAnalysis(
      answer([rec({ hallazgos: [D6], tipo_accion: 'esperar_datos', confianza: 'alta', razonamiento: 'Conviene esperar más datos antes de actuar.' })]),
      snap,
      findings,
    )
    expect(v.errors).toEqual([])
    expect(v.recommendations.find((r) => r.findings.includes(D6))!.confidence).toBe('baja')
    // Not where money is leaking.
    const leak = validateAnalysis(answer([rec({ tipo_accion: 'esperar_datos', razonamiento: 'Conviene esperar más datos.' })]), snap, findings)
    expect(leak.errors.join(' ')).toContain('no corresponde')
  })

  it('adds template text for a high-severity finding the model skipped', () => {
    const only = findings.filter((f) => f.severity === 'alta')
    if (only.length === 0) return
    const v = validateAnalysis(answer([rec({ hallazgos: [D6], tipo_accion: 'consolidar', razonamiento: 'Conviene unir los anuncios repetidos.' })]), snap, findings)
    expect(v.recommendations.some((r) => r.source === 'plantilla')).toBe(true)
  })

  it('rejects broken structure', () => {
    expect(validateAnalysis(null, snap, findings).errors.length).toBeGreaterThan(0)
    expect(validateAnalysis({ resumen: 'x' }, snap, findings).errors.length).toBeGreaterThan(0)
    expect(validateAnalysis(answer([rec({ titulo: '' })]), snap, findings).errors.join(' ')).toContain('falta título')
  })
})

describe('confidenceCap', () => {
  it('caps measurement-only and unproven findings', () => {
    expect(confidenceCap([findings.find((f) => f.code === 'D6')!], snap)).toBe('media')
    expect(confidenceCap([d1], snap)).toBe('alta')
    const thin = { ...snap, coverage: { ...snap.coverage, currentDays: 3 } }
    expect(confidenceCap([d1], thin)).toBe('media')
  })
})

describe('buildAnalystInput', () => {
  it('sends numbers and findings as JSON, with the coverage', () => {
    const body = JSON.parse(buildAnalystInput(snap, findings, { business: 'Vende máquinas.', goal: null, previous: [] }))
    expect(body.negocio).toBe('Vende máquinas.')
    expect(body.hallazgos.map((h: { huella: string }) => h.huella)).toContain(D1)
    expect(body.ventana.cobertura.dias_cubiertos_actual).toBe(snap.coverage.currentDays)
    expect(body.datos.anuncios.length).toBeGreaterThan(0)
  })

  it('has a strict schema the provider can enforce', () => {
    expect(ANALYST_SCHEMA.additionalProperties).toBe(false)
    expect(ANALYST_SCHEMA.properties.recomendaciones.items.required).toContain('hallazgos')
  })
})

describe('runAnalyst', () => {
  const ctx = { business: 'Vende máquinas.', goal: null }
  const usage = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, routerCredits: 0.01 }
  const good = JSON.stringify(
    answer([
      rec(),
      rec({ prioridad: 2, hallazgos: [D2], tipo_accion: 'aprendizaje', titulo: 'Lección de un anuncio caro', razonamiento: 'Ya está pausado: no conviene relanzarlo.' }),
    ]),
  )

  it('uses the model answer when it checks out', async () => {
    const generate: GenerateFn = async () => ({ text: good, usage })
    const r = await runAnalyst({ apiKey: 'k', model: 'm', snapshot: snap, findings, context: ctx, generate })
    expect(r.mode).toBe('modelo')
    expect(r.attempts).toBe(1)
    expect(r.usage?.routerCredits).toBe(0.01)
  })

  it('retries once with the errors and then accepts a corrected answer', async () => {
    const calls: string[] = []
    const generate: GenerateFn = async (a) => {
      calls.push(a.messages.at(-1)!.content)
      return { text: calls.length === 1 ? JSON.stringify(answer([rec({ razonamiento: 'Trajo 37 leads.' })])) : good, usage }
    }
    const r = await runAnalyst({ apiKey: 'k', model: 'm', snapshot: snap, findings, context: ctx, generate })
    expect(r.mode).toBe('modelo')
    expect(r.attempts).toBe(2)
    expect(calls[1]).toContain('37')
    expect(r.usage?.totalTokens).toBe(2400)
  })

  it('falls back to template text when the model keeps failing', async () => {
    const generate: GenerateFn = async () => ({ text: '{ no es json', usage })
    const r = await runAnalyst({ apiKey: 'k', model: 'm', snapshot: snap, findings, context: ctx, generate })
    expect(r.mode).toBe('plantilla')
    expect(r.attempts).toBe(2)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.recommendations.every((x) => x.source === 'plantilla')).toBe(true)
    expect(r.recommendations.length).toBeGreaterThan(0)
  })

  it('falls back when the provider fails, without throwing', async () => {
    const generate: GenerateFn = async () => {
      throw new Error('timeout')
    }
    const r = await runAnalyst({ apiKey: 'k', model: 'm', snapshot: snap, findings, context: ctx, generate })
    expect(r.mode).toBe('plantilla')
    expect(r.errors).toEqual(['timeout'])
  })

  it('does not call the model when nothing was detected', async () => {
    let called = false
    const generate: GenerateFn = async () => {
      called = true
      return { text: '{}', usage }
    }
    const clean = snapshotOf(BASE)
    const r = await runAnalyst({ apiKey: 'k', model: 'm', snapshot: clean, findings: [], context: ctx, generate })
    expect(called).toBe(false)
    expect(r.recommendations).toEqual([])
    expect(r.attempts).toBe(0)
  })
})

describe('templateAnalysis', () => {
  it('writes one recommendation per finding from the numbers alone', () => {
    const t = templateAnalysis(snap, findings)
    expect(t.recommendations[0].priority).toBe(1)
    expect(t.recommendations.find((r) => r.findings.includes(D2))?.action).toBe('aprendizaje')
    expect(t.summary).toContain('redacción automática')
  })
})
