import { describe, it, expect, vi, afterEach } from 'vitest'
import { describeMedia, mediaKindFor, visionModel, IMAGE_MAX_BYTES } from './vision'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('mediaKindFor', () => {
  it('recognises photos and short videos, nothing else', () => {
    expect(mediaKindFor('image/jpeg')).toBe('image')
    expect(mediaKindFor('image/webp; charset=x')).toBe('image')
    expect(mediaKindFor('video/mp4')).toBe('video')
    expect(mediaKindFor('image/gif')).toBeNull()
    expect(mediaKindFor('application/pdf')).toBeNull()
    expect(mediaKindFor(null)).toBeNull()
  })
})

describe('visionModel', () => {
  it('prefers AI_VISION_MODEL, then the account chat model', () => {
    vi.stubEnv('AI_VISION_MODEL', 'gemini-x')
    expect(visionModel('gpt-y')).toBe('gemini-x')
    vi.stubEnv('AI_VISION_MODEL', '')
    expect(visionModel('gpt-y')).toBe('gpt-y')
    expect(visionModel(null)).toBeNull()
  })
})

describe('describeMedia', () => {
  const base = { apiKey: 'k', model: 'm', mimeType: 'image/jpeg', timeoutMs: 1000 }

  it('sends the file as an image_url data URI and returns the description', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '  Una selladora continua.  ' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await describeMedia({ ...base, data: new Uint8Array([1, 2, 3]) })
    expect(out.text).toBe('Una selladora continua.')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const part = body.messages[0].content[1]
    expect(part.type).toBe('image_url')
    expect(part.image_url.url).toBe('data:image/jpeg;base64,AQID')
    expect(body.messages[0].content[0].text).toContain('esta imagen')
  })

  it('uses the video wording for videos', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await describeMedia({ ...base, mimeType: 'video/mp4', data: new Uint8Array([1]) })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[0].content[0].text).toContain('este video')
  })

  it('returns null text for an empty answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: ' ' } }] }), { status: 200 })),
    )
    expect((await describeMedia({ ...base, data: new Uint8Array([1]) })).text).toBeNull()
  })

  it('rejects unsupported formats and oversized files without calling the router', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(describeMedia({ ...base, mimeType: 'application/pdf', data: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'unsupported_media' })
    await expect(describeMedia({ ...base, data: new Uint8Array(IMAGE_MAX_BYTES + 1) })).rejects.toMatchObject({ code: 'media_too_large' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad"}}', { status: 400 })))
    await expect(describeMedia({ ...base, data: new Uint8Array([1]) })).rejects.toBeTruthy()
  })
})
