import { AiError, type AiUsage } from './types'
import { openAiBaseUrl } from './defaults'
import { normalizeUsage, providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Photos and videos to text.
//
// Customers send pictures of the machine they have or the product they want
// to pack. A vision-capable model behind the account's OpenAI-compatible
// gateway describes each one, and the description joins the conversation the
// agent reads. The file goes as an `image_url` data URI: the router accepts
// short videos the same way (tested with Gemini models; `video_url` and
// `file` parts were not read). Bodies much over ~8 MB are rejected by the
// gateway, hence the size limits below.
//
// Never throws for "nothing to say": returns null text. A provider or network
// failure throws AiError and the caller carries on without a description.
// ============================================================

export type MediaKind = 'image' | 'video'

export const IMAGE_MAX_BYTES = 5_000_000
export const VIDEO_MAX_BYTES = 5_000_000

/** Reply the model gives when the file is explicit or offensive. */
export const OFFENSIVE = '[[OFENSIVO]]'

const BASE_PROMPT =
  'Describe en español, en 2 a 4 frases, lo que muestra {what} enviad{a} por un cliente de una empresa que vende máquinas empacadoras y envasadoras. ' +
  'Enfócate en el producto que quiere empacar, el tipo de empaque o la máquina que se ve. ' +
  'Si hay texto legible (etiquetas, medidas, marcas, cantidades), inclúyelo tal cual. ' +
  'Describe solo lo que se ve; no inventes ni supongas nada. Responde solo con la descripción. ' +
  `Excepción: si muestra desnudez, contenido sexual, violencia gráfica, símbolos de odio o material claramente ofensivo o de acoso, no lo describas y responde exactamente: ${OFFENSIVE}`

export function describePrompt(kind: MediaKind): string {
  return kind === 'video'
    ? BASE_PROMPT.replace('{what}', 'este video').replace('enviad{a}', 'enviado')
    : BASE_PROMPT.replace('{what}', 'esta imagen').replace('enviad{a}', 'enviada')
}

/** The model that describes photos and videos: the dedicated one when set,
 *  else the one the account already chats with (it reads images too). */
export function visionModel(chatModel: string | null | undefined): string | null {
  return process.env.AI_VISION_MODEL?.trim() || chatModel?.trim() || null
}

/** Which kind of media a MIME type is, when the model can read it. */
export function mediaKindFor(mimeType: string | null | undefined): MediaKind | null {
  const type = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/jpeg' || type === 'image/jpg' || type === 'image/png' || type === 'image/webp') return 'image'
  if (type === 'video/mp4' || type === 'video/3gpp' || type === 'video/quicktime') return 'video'
  return null
}

interface OpenAiVisionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    credits_charged?: number
  }
}

/**
 * Describe one photo or video. `text` is null when the model returned
 * nothing. `flagged` is true when the model judged the file explicit or
 * offensive (or its safety filter refused it): there is no description then.
 */
export async function describeMedia(args: {
  apiKey: string
  model: string
  data: Uint8Array
  mimeType: string
  timeoutMs: number
}): Promise<{ text: string | null; flagged: boolean; usage: AiUsage | null }> {
  const kind = mediaKindFor(args.mimeType)
  if (!kind) {
    throw new AiError('That media format cannot be described.', { code: 'unsupported_media' })
  }
  const limit = kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES
  if (args.data.byteLength > limit) {
    throw new AiError('The file is too large to describe.', { code: 'media_too_large' })
  }
  const mime = args.mimeType.split(';')[0].trim().toLowerCase()

  let res: Response
  try {
    res = await fetch(`${openAiBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: args.model,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: describePrompt(kind) },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${Buffer.from(args.data).toString('base64')}` },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('Media description', res)

  const data = (await res.json().catch(() => null)) as OpenAiVisionResponse | null
  const raw = data?.choices?.[0]?.message?.content
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    credits: data?.usage?.credits_charged,
  })
  const text = typeof raw === 'string' ? raw.trim() : ''
  const refused = data?.choices?.[0]?.finish_reason === 'content_filter'
  if (refused || text.includes(OFFENSIVE)) return { text: null, flagged: true, usage }
  return { text: text || null, flagged: false, usage }
}
