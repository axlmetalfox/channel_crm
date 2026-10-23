import { generateOpenAiJson } from '../ai/providers/openai'
import type { AiUsage } from '../ai/types'
import { allowedFigures, unsourcedFigures } from './numbers'
import type { Evidence, Finding, FindingCode, Snapshot } from './types'

// ============================================================
// The analyst: a model that ranks and explains the detectors' findings.
//
// It never calculates and never names things itself. It gets numbers already
// computed and picks which findings to talk about; the entity and the evidence
// of every recommendation are copied from those findings by code. What it
// writes (title, reasoning, expected effect, caveats) is checked: every figure
// must come from the data. If it cannot do that after one retry, the findings
// are published with template text instead, never an empty panel.
// ============================================================

export type ActionType =
  | 'revisar_o_pausar'
  | 'redistribuir_presupuesto'
  | 'duplicar_creativo'
  | 'probar_variante'
  | 'consolidar'
  | 'revisar_medicion'
  | 'esperar_datos'
  | 'aprendizaje'

export const ACTIONS: ActionType[] = [
  'revisar_o_pausar',
  'redistribuir_presupuesto',
  'duplicar_creativo',
  'probar_variante',
  'consolidar',
  'revisar_medicion',
  'esperar_datos',
  'aprendizaje',
]

export type Confidence = 'alta' | 'media' | 'baja'

export const MAX_RECOMMENDATIONS = 7

/** Which actions make sense for each kind of finding. */
export const ALLOWED_ACTIONS: Record<FindingCode, ActionType[]> = {
  D1: ['revisar_o_pausar'],
  D2: ['revisar_o_pausar', 'redistribuir_presupuesto', 'probar_variante', 'aprendizaje'],
  D3: ['redistribuir_presupuesto', 'duplicar_creativo'],
  D4: ['revisar_o_pausar', 'probar_variante', 'aprendizaje'],
  D5: ['revisar_o_pausar', 'probar_variante', 'redistribuir_presupuesto'],
  D6: ['consolidar'],
  D7: ['revisar_medicion'],
  D8: ['redistribuir_presupuesto', 'duplicar_creativo', 'probar_variante'],
  D9: ['esperar_datos'],
}

/** What an ad that already stopped can still be used for. */
const PAUSED_ACTIONS: ActionType[] = ['aprendizaje', 'probar_variante', 'esperar_datos']

export interface PreviousRecommendation {
  fingerprint: string
  status: 'nueva' | 'vista' | 'aplicada' | 'descartada'
  feedback: 'util' | 'no_util' | 'equivocada' | null
}

export interface AnalystContext {
  /** What the business sells and who it sells to, in a few sentences. */
  business: string
  /** What counts as success (e.g. a cost per lead), or null. */
  goal: string | null
  previous?: PreviousRecommendation[]
}

export interface Recommendation {
  priority: number
  title: string
  action: ActionType
  /** The entity of the first linked finding. */
  entity: Finding['entity']
  findings: string[]
  /** Copied from the linked findings. */
  evidence: Evidence[]
  reasoning: string
  expectedEffect: string | null
  confidence: Confidence
  caveats: string[]
  /** Money at stake across the linked findings. */
  money: number
  source: 'modelo' | 'plantilla'
}

// ---- Prompt and schema ------------------------------------------------------

export const SYSTEM_PROMPT = `Eres el analista de anuncios de una empresa. Recibes los números de sus campañas de Meta ya calculados y una lista de hallazgos detectados por reglas. Tu trabajo es priorizar, conectar y explicar, en español claro para una persona de negocio que no es experta en pauta.

REGLAS
1. No calculas nada. Cita únicamente cifras que aparezcan en "datos" o en los hallazgos, con el mismo redondeo. Si necesitas una cifra que no está, no la uses. Una cifra inventada invalida tu respuesta.
2. No nombres anuncios ni campañas por tu cuenta: refiérete a los hallazgos por su "huella". El sistema añade la entidad y la evidencia. En el texto puedes citar el nombre entre comillas angulares «así», tal como aparece en los datos.
3. Propones, no ordenas: "conviene revisar", "podría probarse". Nunca digas que algo se hizo.
4. Ordena por dinero en juego y confianza. Une en una sola recomendación los hallazgos que cuentan la misma historia (el primero de "hallazgos" es el principal). Máximo ${MAX_RECOMMENDATIONS} recomendaciones; mejor pocas y buenas.
5. Un anuncio ya pausado solo da una lección ("aprendizaje"): nunca propongas pausarlo ni moverle presupuesto.
6. Si la evidencia es débil o la muestra pequeña, usa "esperar_datos" y confianza "baja". Nada de forzar conclusiones. La cobertura de los datos puede ser menor que la ventana: dilo en las advertencias cuando afecte.
7. Si una recomendación previa fue descartada o marcada como no útil, no la repitas salvo que la evidencia haya empeorado; si fue aplicada, di si se nota efecto solo cuando los datos lo muestren.
8. "resumen": 2 a 4 frases con lo más importante de la semana. Sin listas.

ACCIONES (tipo_accion)
- revisar_o_pausar: revisar o pausar un anuncio o campaña que gasta sin resultados o con mal costo.
- redistribuir_presupuesto: mover presupuesto de lo que rinde peor hacia lo que rinde mejor.
- duplicar_creativo: replicar un mensaje o creativo que funciona en otros conjuntos o públicos.
- probar_variante: probar una variante (mensaje, público, formato) con una hipótesis concreta.
- consolidar: unir anuncios repetidos que compiten entre sí.
- revisar_medicion: revisar a dónde llegan los chats o cómo se mide.
- esperar_datos: todavía no hay datos suficientes.
- aprendizaje: lección de algo que ya terminó.

CONFIANZA: "alta" solo con muestra amplia y varias cifras que coincidan; "media" si hay una señal clara con muestra moderada; "baja" si es una hipótesis.
Responde solo con el JSON pedido.`

/** JSON Schema for the reply (strict mode: every property required, no extras). */
export const ANALYST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'recomendaciones'],
  properties: {
    resumen: { type: 'string' },
    recomendaciones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prioridad', 'titulo', 'tipo_accion', 'hallazgos', 'razonamiento', 'efecto_esperado', 'confianza', 'advertencias'],
        properties: {
          prioridad: { type: 'integer' },
          titulo: { type: 'string' },
          tipo_accion: { type: 'string', enum: ACTIONS },
          hallazgos: { type: 'array', items: { type: 'string' } },
          razonamiento: { type: 'string' },
          efecto_esperado: { type: ['string', 'null'] },
          confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
          advertencias: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)

function metricsView(m: Snapshot['account']['current']) {
  return {
    gasto: Math.round(m.spend),
    conversaciones: m.conversations,
    leads: m.leads,
    conversaciones_segun_meta: Math.round(m.platformConversations),
    costo_por_conversacion: round(m.costPerConversation),
    costo_por_lead: round(m.costPerLead),
    tasa_chat_a_lead: m.leadRate === null ? null : round(m.leadRate),
  }
}

/** The user message: context, the numbers and the findings, as compact JSON. */
export function buildAnalystInput(snapshot: Snapshot, findings: Finding[], context: AnalystContext): string {
  const flagged = new Set(findings.map((f) => f.entity.id))
  const ads = snapshot.ads
    .filter((a, i) => i < 15 || flagged.has(a.id))
    .map((a) => ({
      id: a.id,
      nombre: a.headline ?? a.name,
      campana: a.campaignName,
      conjunto: a.adSetName,
      estado: a.status,
      dias_activo: a.ageDays,
      actual: metricsView(a.current),
      previo: snapshot.coverage.previousComplete ? metricsView(a.previous) : null,
    }))
  const payload = {
    negocio: context.business,
    objetivo: context.goal,
    moneda: snapshot.currency,
    ventana: {
      dias: snapshot.windows.days,
      actual: snapshot.windows.current,
      cobertura: {
        atribucion_desde: snapshot.coverage.attributionSince,
        dias_cubiertos_actual: snapshot.coverage.currentDays,
        periodo_previo_comparable: snapshot.coverage.previousComplete,
      },
    },
    datos: {
      cuenta: {
        ...metricsView(snapshot.account.current),
        conversaciones_sin_anuncio: snapshot.account.directConversations.current,
      },
      campanas: snapshot.campaigns.slice(0, 10).map((c) => ({
        id: c.id,
        nombre: c.name,
        estado: c.status,
        anuncios: c.adCount,
        actual: metricsView(c.current),
      })),
      anuncios: ads,
    },
    hallazgos: findings.map((f) => ({
      huella: f.fingerprint,
      codigo: f.code,
      tipo: f.type,
      entidad: f.entity,
      severidad: f.severity,
      dinero_en_juego: f.money,
      evidencia: f.evidence.map((e) => ({ metrica: e.metric, valor: round(e.value), referencia: e.reference === undefined ? null : round(e.reference) })),
      resumen: f.summary,
    })),
    recomendaciones_previas: context.previous ?? [],
  }
  return JSON.stringify(payload)
}

// ---- Validation -------------------------------------------------------------

interface RawRecommendation {
  prioridad?: unknown
  titulo?: unknown
  tipo_accion?: unknown
  hallazgos?: unknown
  razonamiento?: unknown
  efecto_esperado?: unknown
  confianza?: unknown
  advertencias?: unknown
}

export interface Validation {
  summary: string
  recommendations: Recommendation[]
  /** Reasons the answer cannot be used as is. */
  errors: string[]
  /** Things we fixed ourselves (a confidence lowered, a finding added). */
  warnings: string[]
}

const CONFIDENCE_RANK: Record<Confidence, number> = { baja: 0, media: 1, alta: 2 }

/** The highest confidence the findings allow. */
export function confidenceCap(findings: Finding[], snapshot: Snapshot): Confidence {
  const codes = new Set(findings.map((f) => f.code))
  if (codes.has('D9') && codes.size === 1) return 'baja'
  if ([...codes].every((c) => c === 'D6' || c === 'D7' || c === 'D8' || c === 'D9')) return 'media'
  return snapshot.coverage.currentDays >= 7 ? 'alta' : 'media'
}

function lower(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** The actions allowed for a group of findings (an ad already paused only teaches). */
function actionsFor(linked: Finding[]): ActionType[] {
  const allowed = new Set<ActionType>()
  for (const f of linked) {
    const paused = f.entity.type === 'anuncio' && f.entity.status !== undefined && f.entity.status !== 'active'
    for (const a of ALLOWED_ACTIONS[f.code]) {
      if (!paused || PAUSED_ACTIONS.includes(a)) allowed.add(a)
    }
    // "Wait and see" is always a fair call, except where real money is leaking.
    if (f.severity !== 'alta') allowed.add('esperar_datos')
    if (paused) for (const a of PAUSED_ACTIONS) if (ALLOWED_ACTIONS[f.code].includes(a)) allowed.add(a)
  }
  return [...allowed]
}

/** Check the model's reply against the findings and the data, and build the recommendations. */
export function validateAnalysis(raw: unknown, snapshot: Snapshot, findings: Finding[]): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  const out: Validation = { summary: '', recommendations: [], errors, warnings }
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]))

  if (!raw || typeof raw !== 'object') {
    errors.push('La respuesta no es un objeto JSON.')
    return out
  }
  const body = raw as { resumen?: unknown; recomendaciones?: unknown }
  if (!isString(body.resumen)) errors.push('Falta "resumen".')
  if (!Array.isArray(body.recomendaciones)) {
    errors.push('Falta "recomendaciones" (lista).')
    return out
  }
  if (body.recomendaciones.length > MAX_RECOMMENDATIONS) {
    errors.push(`Hay ${body.recomendaciones.length} recomendaciones; el máximo es ${MAX_RECOMMENDATIONS}.`)
  }

  const allFigures = allowedFigures(snapshot, findings)
  const checkText = (label: string, text: string | null, figures: number[]) => {
    if (!text) return
    const bad = unsourcedFigures(text, figures)
    if (bad.length > 0) errors.push(`${label}: cifras que no están en los datos: ${bad.join(', ')}.`)
  }
  if (isString(body.resumen)) {
    checkText('resumen', body.resumen, allFigures)
    out.summary = body.resumen.trim()
  }

  const used = new Set<string>()
  body.recomendaciones.slice(0, MAX_RECOMMENDATIONS).forEach((item, i) => {
    const r = (item ?? {}) as RawRecommendation
    const where = `recomendación ${i + 1}`
    if (!isString(r.titulo) || !isString(r.razonamiento)) {
      errors.push(`${where}: falta título o razonamiento.`)
      return
    }
    if (!isStringArray(r.hallazgos) || r.hallazgos.length === 0) {
      errors.push(`${where}: debe citar al menos un hallazgo (huella).`)
      return
    }
    const linked: Finding[] = []
    for (const fp of r.hallazgos) {
      const f = byFingerprint.get(fp)
      if (!f) errors.push(`${where}: la huella «${fp}» no existe.`)
      else if (!linked.includes(f)) linked.push(f)
    }
    if (linked.length === 0) return

    const action = r.tipo_accion as ActionType
    if (!ACTIONS.includes(action)) {
      errors.push(`${where}: tipo_accion «${String(r.tipo_accion)}» no es válido.`)
      return
    }
    const allowed = actionsFor(linked)
    if (!allowed.includes(action)) {
      errors.push(`${where}: la acción «${action}» no corresponde a esos hallazgos (válidas: ${allowed.join(', ')}).`)
    }

    const confidence = (['alta', 'media', 'baja'] as const).includes(r.confianza as Confidence)
      ? (r.confianza as Confidence)
      : 'baja'
    // A recommendation to wait is, by definition, a low-confidence one.
    const cap = linked.map((f) => confidenceCap([f], snapshot)).reduce(lower, action === 'esperar_datos' ? 'baja' : 'alta')
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[cap]) {
      warnings.push(`${where}: la confianza se bajó de ${confidence} a ${cap} porque la muestra no alcanza.`)
    }

    const figures = allowedFigures(snapshot, linked)
    const effect = isString(r.efecto_esperado) ? r.efecto_esperado.trim() : null
    const caveats = isStringArray(r.advertencias) ? r.advertencias.filter((c) => c.trim()) : []
    checkText(`${where} (título)`, r.titulo, figures)
    checkText(`${where} (razonamiento)`, r.razonamiento, figures)
    checkText(`${where} (efecto esperado)`, effect, figures)
    caveats.forEach((c) => checkText(`${where} (advertencia)`, c, figures))

    linked.forEach((f) => used.add(f.fingerprint))
    out.recommendations.push({
      priority: typeof r.prioridad === 'number' ? r.prioridad : i + 1,
      title: r.titulo.trim(),
      action,
      entity: linked[0].entity,
      findings: linked.map((f) => f.fingerprint),
      evidence: linked.flatMap((f) => f.evidence),
      reasoning: r.razonamiento.trim(),
      expectedEffect: effect,
      confidence: lower(confidence, cap),
      caveats,
      money: linked.reduce((n, f) => n + f.money, 0),
      source: 'modelo',
    })
  })

  // A finding that puts real money at stake must not disappear because the model skipped it.
  for (const f of findings) {
    if (f.severity === 'alta' && !used.has(f.fingerprint)) {
      warnings.push(`El hallazgo «${f.fingerprint}» (severidad alta) no estaba cubierto; se añadió con texto de plantilla.`)
      out.recommendations.push(templateRecommendation(f, snapshot))
    }
  }

  out.recommendations.sort((a, b) => a.priority - b.priority)
  out.recommendations.forEach((r, i) => {
    r.priority = i + 1
  })
  return out
}

// ---- Template fallback ------------------------------------------------------

const DEFAULT_ACTION: Record<FindingCode, ActionType> = {
  D1: 'revisar_o_pausar',
  D2: 'revisar_o_pausar',
  D3: 'redistribuir_presupuesto',
  D4: 'probar_variante',
  D5: 'revisar_o_pausar',
  D6: 'consolidar',
  D7: 'revisar_medicion',
  D8: 'redistribuir_presupuesto',
  D9: 'esperar_datos',
}

const TITLES: Record<FindingCode, string> = {
  D1: 'Gasto sin resultados',
  D2: 'Costo por lead muy por encima del promedio',
  D3: 'Anuncio eficiente con poco presupuesto',
  D4: 'Muchos chats que no se convierten en leads',
  D5: 'El costo por conversación está subiendo',
  D6: 'Mismo titular en varios conjuntos',
  D7: 'Meta y TUYO no coinciden en las conversaciones',
  D8: 'Gasto concentrado en un solo anuncio',
  D9: 'Todavía faltan datos para juzgar',
}

/** A recommendation written by code from one finding, for when no model text can be used. */
export function templateRecommendation(f: Finding, snapshot: Snapshot): Recommendation {
  const paused = f.entity.type === 'anuncio' && f.entity.status !== undefined && f.entity.status !== 'active'
  return {
    priority: 0,
    title: TITLES[f.code],
    action: paused && ['D2', 'D4'].includes(f.code) ? 'aprendizaje' : DEFAULT_ACTION[f.code],
    entity: f.entity,
    findings: [f.fingerprint],
    evidence: f.evidence,
    reasoning: f.summary,
    expectedEffect: null,
    confidence: confidenceCap([f], snapshot),
    caveats: [],
    money: f.money,
    source: 'plantilla',
  }
}

/** The whole analysis written by code: used when the model is unavailable or keeps failing. */
export function templateAnalysis(snapshot: Snapshot, findings: Finding[]): { summary: string; recommendations: Recommendation[] } {
  const recs = findings.slice(0, MAX_RECOMMENDATIONS).map((f, i) => ({ ...templateRecommendation(f, snapshot), priority: i + 1 }))
  const summary =
    findings.length === 0
      ? 'No se detectó nada que requiera atención en este periodo.'
      : `Se detectaron ${findings.length} hallazgos; se muestran los ${recs.length} de mayor impacto (redacción automática).`
  return { summary, recommendations: recs }
}

// ---- Running ----------------------------------------------------------------

export interface GenerateArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  schemaName: string
  schema: object
  timeoutMs: number
  maxOutputTokens: number
}

export type GenerateFn = (args: GenerateArgs) => Promise<{ text: string; usage: AiUsage | null }>

const defaultGenerate: GenerateFn = (args) => generateOpenAiJson(args)

export interface AnalysisResult {
  summary: string
  recommendations: Recommendation[]
  mode: 'modelo' | 'plantilla'
  attempts: number
  usage: AiUsage | null
  warnings: string[]
  /** Why the model's answer was not used (empty when it was). */
  errors: string[]
}

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  const credits = (a.routerCredits ?? 0) + (b.routerCredits ?? 0)
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.routerCredits !== undefined || b.routerCredits !== undefined ? { routerCredits: credits } : {}),
  }
}

export interface RunAnalystArgs {
  apiKey: string
  model: string
  snapshot: Snapshot
  findings: Finding[]
  context: AnalystContext
  generate?: GenerateFn
  timeoutMs?: number
}

/**
 * Ask the model, check the answer, retry once with the errors, and fall back to
 * template text. Never throws for a bad answer or a provider failure.
 */
export async function runAnalyst(args: RunAnalystArgs): Promise<AnalysisResult> {
  const { snapshot, findings } = args
  // Nothing detected: no reason to spend a model call.
  if (findings.length === 0) {
    const t = templateAnalysis(snapshot, findings)
    return { ...t, mode: 'plantilla', attempts: 0, usage: null, warnings: [], errors: [] }
  }

  const generate = args.generate ?? defaultGenerate
  const input = buildAnalystInput(snapshot, findings, args.context)
  const messages: GenerateArgs['messages'] = [{ role: 'user', content: input }]
  let usage: AiUsage | null = null
  let errors: string[] = []
  let attempts = 0

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt
    try {
      const res = await generate({
        apiKey: args.apiKey,
        model: args.model,
        systemPrompt: SYSTEM_PROMPT,
        messages,
        schemaName: 'ads_analysis',
        schema: ANALYST_SCHEMA,
        timeoutMs: args.timeoutMs ?? 120_000,
        maxOutputTokens: 6000,
      })
      usage = addUsage(usage, res.usage)
      let parsed: unknown
      try {
        parsed = JSON.parse(res.text)
      } catch {
        errors = ['La respuesta no es JSON válido.']
        messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: `Tu respuesta no se pudo usar: ${errors.join(' ')} Responde de nuevo solo con el JSON pedido.` })
        continue
      }
      const v = validateAnalysis(parsed, snapshot, findings)
      if (v.errors.length === 0) {
        return { summary: v.summary, recommendations: v.recommendations, mode: 'modelo', attempts, usage, warnings: v.warnings, errors: [] }
      }
      errors = v.errors
      messages.push(
        { role: 'assistant', content: res.text },
        { role: 'user', content: `Tu respuesta tiene estos errores, corrígelos y responde de nuevo solo con el JSON:\n- ${v.errors.join('\n- ')}` },
      )
    } catch (err) {
      errors = [err instanceof Error ? err.message : 'El modelo no respondió.']
      break
    }
  }

  const t = templateAnalysis(snapshot, findings)
  return { ...t, mode: 'plantilla', attempts, usage, warnings: [], errors }
}
