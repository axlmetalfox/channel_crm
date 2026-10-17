import { AiError, type AiUsage } from './types'
import { openAiBaseUrl } from './defaults'
import { normalizeUsage, providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Voice notes to text.
//
// Customers often send audio instead of typing. An audio-capable model
// behind the account's OpenAI-compatible gateway (the Hostinger AI
// router offers Gemini models for it) turns the voice note into text, so
// the agent can answer what was said. The audio is passed as an
// `input_audio` part: that is the form that returned the right text in
// testing; other ways of attaching the same bytes sometimes produced an
// unrelated sentence, so do not change it without testing real notes.
//
// Off unless AI_TRANSCRIBE_MODEL is set. Never throws for "could not
// make it out": returns null text so the caller falls back to asking the
// customer to write.
// ============================================================

/** Reply the model gives when there is no speech or it cannot be made out. */
const NO_SPEECH = '[[SIN_VOZ]]'

const PROMPT =
  'Transcribe literalmente este mensaje de voz de WhatsApp en español. ' +
  'Responde solo con lo que dice la persona, sin comentarios ni explicaciones. ' +
  `Si no hay voz, solo ruido, o no se entiende nada, responde exactamente: ${NO_SPEECH}`

/** Audio the router can take, by MIME type -> `input_audio.format`. WhatsApp
 *  voice notes are OGG/Opus. */
export function audioFormatFor(mimeType: string | null | undefined): string | null {
  const type = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'audio/ogg' || type === 'audio/opus' || type === 'application/ogg') return 'opus'
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'mp3'
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave') return 'wav'
  return null
}

/** The model that transcribes voice notes, or null when the feature is off. */
export function transcriptionModel(): string | null {
  return process.env.AI_TRANSCRIBE_MODEL?.trim() || null
}

/** Largest voice note worth transcribing (about two minutes of Opus). */
export const AUDIO_MAX_BYTES = 1_000_000

interface OpenAiAudioResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    credits_charged?: number
  }
}

/**
 * Transcribe one voice note. `text` is null when the model heard no
 * speech. Throws AiError on a provider or network failure.
 */
export async function transcribeAudio(args: {
  apiKey: string
  model: string
  audio: Uint8Array
  mimeType: string | null
  timeoutMs: number
}): Promise<{ text: string | null; usage: AiUsage | null }> {
  const format = audioFormatFor(args.mimeType)
  if (!format) {
    throw new AiError('That audio format cannot be transcribed.', { code: 'unsupported_audio' })
  }
  if (args.audio.byteLength > AUDIO_MAX_BYTES) {
    throw new AiError('The voice note is too long to transcribe.', { code: 'audio_too_long' })
  }
  const url = `${openAiBaseUrl()}/chat/completions`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: args.model,
        max_tokens: 800,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'input_audio',
                input_audio: { data: Buffer.from(args.audio).toString('base64'), format },
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
  if (!res.ok) throw await providerHttpError('Transcription', res)

  const data = (await res.json().catch(() => null)) as OpenAiAudioResponse | null
  const raw = data?.choices?.[0]?.message?.content
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
    credits: data?.usage?.credits_charged,
  })
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.includes(NO_SPEECH)) return { text: null, usage }
  return { text, usage }
}
