import { describe, it, expect } from 'vitest'
import { detectFindings } from './detectors'
import { BASE, snapshotOf, type AdSpec } from './fixtures'

const codes = (specs: AdSpec[]) => detectFindings(snapshotOf(specs)).map((f) => `${f.code}:${f.entity.id}`)

describe('detectFindings', () => {
  it('finds nothing wrong with ordinary ads', () => {
    expect(codes(BASE)).toEqual([])
  })

  it('D1: an active ad with plenty of spend and no chats', () => {
    const out = detectFindings(snapshotOf([...BASE, { id: 'bad', chats: 0 }]))
    const f = out.find((x) => x.code === 'D1')!
    expect(f.entity.id).toBe('bad')
    expect(f.money).toBe(140000)
    expect(f.summary).toContain('no trajo ninguna conversación')
    expect(f.fingerprint).toBe('gasto_sin_resultados:anuncio:bad')
  })

  it('D1 waits for the ad to be old enough, to be active, and for real spend', () => {
    const young = snapshotOf([...BASE, { id: 'new', chats: 0 }])
    young.ads.find((a) => a.id === 'new')!.ageDays = 2
    expect(detectFindings(young).map((f) => f.entity.id)).not.toContain('new')

    expect(codes([...BASE, { id: 'paused', chats: 0, catalog: { status: 'paused' } }])).not.toContain('D1:paused')
    // A tiny spend is not enough to say anything.
    expect(codes([...BASE, { id: 'tiny', chats: 0, spend: 100 }])).not.toContain('D1:tiny')
  })

  it('D2: much more expensive per lead than the account, with enough leads', () => {
    expect(codes([...BASE, { id: 'dear', spend: 40000, chats: 28, leads: 7 }])).toContain('D2:dear')
    // Same cost, too few leads: no verdict.
    expect(codes([...BASE, { id: 'few', spend: 40000, chats: 8, leads: 2 }])).not.toContain('D2:few')
  })

  it('D2 still flags an expensive ad that is already paused, as a lesson', () => {
    const out = detectFindings(snapshotOf([...BASE, { id: 'gone', spend: 40000, chats: 28, leads: 7, catalog: { status: 'paused' } }]))
    const f = out.find((x) => x.code === 'D2')!
    expect(f.entity).toMatchObject({ id: 'gone', status: 'paused' })
    expect(f.summary).toContain('ya está pausado')
    // Paused ads are never offered as a place to put more money, nor counted as a risk.
    const cheap = detectFindings(snapshotOf([...BASE, { id: 'cheapgone', spend: 3000, chats: 28, leads: 7, catalog: { status: 'paused' } }]))
    expect(cheap.map((x) => x.code)).not.toContain('D3')
  })

  it('D3: cheap leads on an ad with a small share of the spend', () => {
    const out = codes([...BASE, { id: 'cheap', spend: 3000, chats: 28, leads: 7 }])
    expect(out).toContain('D3:cheap')
  })

  it('D4: many chats that rarely become leads', () => {
    const out = detectFindings(snapshotOf([...BASE, { id: 'cold', chats: 40, leads: 2 }]))
    expect(out.find((x) => x.code === 'D4')?.entity.id).toBe('cold')
    expect(codes([...BASE, { id: 'small', chats: 10, leads: 0 }])).not.toContain('D4:small')
  })

  it('D5: cost per chat up by a third at similar spend', () => {
    const out = codes([
      ...BASE,
      { id: 'drift', prevSpend: 10000, spend: 10500, prevChats: 28, chats: 18, prevLeads: 7, leads: 4 },
    ])
    expect(out).toContain('D5:drift')
    // A big change in spend is a different story, not a trend.
    expect(codes([...BASE, { id: 'scaled', prevSpend: 5000, spend: 10000, prevChats: 28, chats: 18, leads: 4 }])).not.toContain('D5:scaled')
  })

  it('D5 needs the previous window fully covered by attribution', () => {
    const specs: AdSpec[] = [...BASE, { id: 'drift', prevSpend: 10000, spend: 10500, prevChats: 28, chats: 18, prevLeads: 7, leads: 4 }]
    const snap = snapshotOf(specs)
    snap.coverage.previousComplete = false
    expect(detectFindings(snap).map((f) => f.code)).not.toContain('D5')
  })

  it('D6: the same headline in several ad sets', () => {
    const out = detectFindings(
      snapshotOf([
        { id: 'x1', headline: 'Máquinas en stock', chats: 28, leads: 7 },
        { id: 'x2', headline: 'máquinas en stock', chats: 28, leads: 7 },
        { id: 'z', chats: 28, leads: 7 },
      ]),
    )
    const f = out.find((x) => x.code === 'D6')!
    expect(f.entity.type).toBe('grupo')
    expect(f.entity.id).toBe('x1,x2')
    expect(f.severity).toBe('baja')
  })

  it('D7: the platform and TUYO disagree on the chats of a campaign', () => {
    const out = detectFindings(snapshotOf([{ id: 'm1', catalog: { campaign_id: 'c9', campaign_name: 'OTRA' }, chats: 30, leads: 6, metaChats: 70 }, ...BASE]))
    expect(out.find((x) => x.code === 'D7')?.evidence[0]).toMatchObject({ value: 70, reference: 30 })
  })

  it('D8: one ad takes most of the spend', () => {
    const out = codes([{ id: 'big', spend: 100000, chats: 200, leads: 40 }, { id: 's', spend: 5000, chats: 10, leads: 2 }])
    expect(out).toContain('D8:big')
  })

  it('D9: real spend on an ad with too little data to judge', () => {
    const out = codes([...BASE, { id: 'wait', chats: 6, leads: 1 }])
    expect(out).toContain('D9:wait')
    // Not repeated for an ad already flagged by a stronger rule.
    expect(codes([...BASE, { id: 'bad', chats: 0 }])).not.toContain('D9:bad')
  })

  it('ranks the biggest money first and gives stable fingerprints', () => {
    const out = detectFindings(snapshotOf([...BASE, { id: 'bad', chats: 0 }, { id: 'dear', spend: 40000, chats: 28, leads: 7 }]))
    const money = out.filter((f) => f.severity === out[0].severity).map((f) => f.money)
    expect(money).toEqual([...money].sort((a, b) => b - a))
    const again = detectFindings(snapshotOf([...BASE, { id: 'bad', chats: 0 }, { id: 'dear', spend: 40000, chats: 28, leads: 7 }]))
    expect(again.map((f) => f.fingerprint)).toEqual(out.map((f) => f.fingerprint))
  })

  it('says nothing for an empty account', () => {
    expect(detectFindings(snapshotOf([]))).toEqual([])
  })
})
