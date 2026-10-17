import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { audioFormatFor, AUDIO_MAX_BYTES, transcribeAudio, transcriptionModel } from './transcribe'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AI_TRANSCRIBE_MODEL
})

const ok = (content: string, credits = 0.004) =>
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 300, completion_tokens: 20, credits_charged: credits },
    }),
  })

const args = (over: Record<string, unknown> = {}) => ({
  apiKey: 'sk-test',
  model: 'gemini-2.5-flash-lite',
  audio: new Uint8Array([79, 103, 103, 83]),
  mimeType: 'audio/ogg; codecs=opus',
  timeoutMs: 5000,
  ...over,
})

describe('audioFormatFor', () => {
  it('maps WhatsApp voice notes (OGG/Opus), mp3 and wav, and rejects anything else', () => {
    expect(audioFormatFor('audio/ogg; codecs=opus')).toBe('opus')
    expect(audioFormatFor('audio/ogg')).toBe('opus')
    expect(audioFormatFor('audio/mpeg')).toBe('mp3')
    expect(audioFormatFor('audio/wav')).toBe('wav')
    expect(audioFormatFor('audio/amr')).toBeNull()
    expect(audioFormatFor(null)).toBeNull()
  })
})

describe('transcriptionModel', () => {
  it('is off unless a model is set', () => {
    expect(transcriptionModel()).toBeNull()
    process.env.AI_TRANSCRIBE_MODEL = ' gemini-2.5-flash-lite '
    expect(transcriptionModel()).toBe('gemini-2.5-flash-lite')
  })
})

describe('transcribeAudio', () => {
  it('sends the audio as input_audio (opus) with the transcription instruction and returns the text and cost', async () => {
    ok('  Hola, soy Alex. Necesito una máquina para empacar queso.  ')
    const out = await transcribeAudio(args())
    expect(out.text).toBe('Hola, soy Alex. Necesito una máquina para empacar queso.')
    expect(out.usage?.routerCredits).toBeCloseTo(0.004)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/chat\/completions$/)
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gemini-2.5-flash-lite')
    const parts = body.messages[0].content
    expect(parts[0].text).toMatch(/Transcribe literalmente/)
    expect(parts[1]).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from([79, 103, 103, 83]).toString('base64'), format: 'opus' },
    })
    expect(init.headers.Authorization).toBe('Bearer sk-test')
  })

  it('returns null text when there is no speech, instead of inventing some', async () => {
    ok('[[SIN_VOZ]]')
    expect((await transcribeAudio(args())).text).toBeNull()
    ok('   ')
    expect((await transcribeAudio(args())).text).toBeNull()
  })

  it('refuses unsupported formats and notes that are too long, without calling the provider', async () => {
    await expect(transcribeAudio(args({ mimeType: 'audio/amr' }))).rejects.toMatchObject({ code: 'unsupported_audio' })
    await expect(
      transcribeAudio(args({ audio: new Uint8Array(AUDIO_MAX_BYTES + 1) })),
    ).rejects.toMatchObject({ code: 'audio_too_long' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('raises on a provider error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad audio' } }),
    })
    await expect(transcribeAudio(args())).rejects.toThrow()
  })
})
