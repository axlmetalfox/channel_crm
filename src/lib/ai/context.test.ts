import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('includes a transcribed voice note, marked so the agent knows it may contain mistakes', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'audio', content_text: 'necesito una empacadora' },
        { sender_type: 'customer', content_type: 'text', content_text: 'hola' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'user', content: '[Audio transcrito] necesito una empacadora' },
    ])
  })

  it('includes photos and videos with their automatic description, and without one when it failed', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'video', content_text: null, ai_description: null },
        { sender_type: 'customer', content_type: 'image', content_text: 'así lo quiero', ai_description: 'Una bolsa de café.' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      {
        role: 'user',
        content:
          '[El cliente envió una imagen. Descripción automática, puede tener errores: Una bolsa de café. Texto que la acompaña: así lo quiero]',
      },
      { role: 'user', content: '[El cliente envió un video. No se pudo analizar el contenido.]' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})
