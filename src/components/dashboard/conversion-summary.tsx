"use client"

import { useCallback, useEffect, useState } from 'react'
import { Bot, CheckCheck, MessageSquare, Percent, Target, UserCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { loadConversionSummary, type ConversionSummary } from '@/lib/dashboard/conversion'
import { daysAgoStart, localDayKey } from '@/lib/dashboard/date-utils'
import { cn } from '@/lib/utils'
import { MetricCard } from './metric-card'
import { Skeleton } from './skeleton'

type Preset = 'today' | 'yesterday' | '7' | '30' | 'month'

function presetRange(preset: Preset): { from: string; to: string } {
  const today = localDayKey(new Date())
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = localDayKey(daysAgoStart(1))
      return { from: y, to: y }
    }
    case '7':
      return { from: localDayKey(daysAgoStart(6)), to: today }
    case '30':
      return { from: localDayKey(daysAgoStart(29)), to: today }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today }
  }
}

const PRESETS: Preset[] = ['today', 'yesterday', '7', '30', 'month']

/** 45 -> "45 min", 135 -> "2 h 15 min", 1700 -> "1 d 4 h". */
function formatDuration(minutes: number): string {
  const m = Math.round(minutes)
  if (m < 60) return `${m} min`
  if (m < 60 * 24) {
    const mm = m % 60
    return mm ? `${Math.floor(m / 60)} h ${mm} min` : `${Math.floor(m / 60)} h`
  }
  const h = Math.round((m % (60 * 24)) / 60)
  return h ? `${Math.floor(m / (60 * 24))} d ${h} h` : `${Math.floor(m / (60 * 24))} d`
}

/**
 * Incoming conversations and how many ended in a registered lead (by the AI
 * agent or by a person), for a date range picked with the native calendar.
 */
export function ConversionSummaryPanel() {
  const t = useTranslations('Dashboard.conversion')
  const [initialRange] = useState(() => presetRange('7'))
  const [range, setRange] = useState(initialRange)
  const [data, setData] = useState<ConversionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  // Only fetches; the loading flags are set by whoever changes the range,
  // so no state is set synchronously inside an effect.
  const fetchRange = useCallback((from: string, to: string) => {
    loadConversionSummary(createClient(), from, to)
      .then(setData)
      .catch((err) => {
        console.error('[dashboard] conversion failed:', err)
        setFailed(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchRange(initialRange.from, initialRange.to)
  }, [fetchRange, initialRange])

  const select = (next: { from: string; to: string }) => {
    setRange(next)
    setLoading(true)
    setFailed(false)
    fetchRange(next.from, next.to)
  }

  const change = (patch: Partial<{ from: string; to: string }>) => {
    const next = { ...range, ...patch }
    if (!next.from || !next.to) return
    // Keep the range the right way round.
    if (next.from > next.to) {
      if (patch.from) next.to = next.from
      else next.from = next.to
    }
    select(next)
  }

  const percent = (rate: number) => `${(rate * 100).toFixed(1).replace(/\.0$/, '')}%`
  const today = localDayKey(new Date())

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {PRESETS.map((p) => {
              const r = presetRange(p)
              const active = r.from === range.from && r.to === range.to
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => select(r)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    active
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`preset.${p}`)}
                </button>
              )
            })}
          </div>
          <label className="text-xs text-muted-foreground">
            {t('from')}
            <input
              type="date"
              value={range.from}
              max={today}
              onChange={(e) => change({ from: e.target.value })}
              className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            {t('to')}
            <input
              type="date"
              value={range.to}
              max={today}
              onChange={(e) => change({ to: e.target.value })}
              className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>
        </div>
      </header>

      <div className="space-y-4 p-5">
        {failed ? (
          <p className="text-sm text-muted-foreground">{t('error')}</p>
        ) : loading || !data ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[112px] w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <MetricCard
                title={t('incoming')}
                value={data.incoming.toLocaleString()}
                icon={MessageSquare}
                subtitle={t('incomingHint')}
              />
              <MetricCard
                title={t('converted')}
                value={data.converted.toLocaleString()}
                icon={CheckCheck}
                subtitle={t('convertedHint')}
              />
              <MetricCard
                title={t('byAi')}
                value={data.byAi.toLocaleString()}
                icon={Bot}
                subtitle={t('byAiHint')}
              />
              <MetricCard
                title={t('byHuman')}
                value={data.byHuman.toLocaleString()}
                icon={UserCheck}
                subtitle={t('byHumanHint')}
              />
              <MetricCard
                title={t('rate')}
                value={percent(data.rate)}
                icon={Percent}
                subtitle={t('rateHint')}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <MetricCard
                title={t('aiEffectiveness')}
                value={percent(data.ai.rate)}
                icon={Target}
                subtitle={t('aiEffectivenessHint', {
                  registered: data.ai.registered,
                  interviewed: data.ai.interviewed,
                })}
              />
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <p className="text-sm font-medium text-muted-foreground">{t('agentsTitle')}</p>
                {data.agents.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">{t('agentsEmpty')}</p>
                ) : (
                  <table className="mt-3 w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 pr-4 font-medium">{t('agentName')}</th>
                        <th className="py-2 pr-4 text-right font-medium">{t('agentRegistered')}</th>
                        <th className="py-2 text-right font-medium">{t('agentAvg')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.agents.map((a) => (
                        <tr key={a.userId} className="border-b border-border/50 last:border-0">
                          <td className="py-2 pr-4 text-foreground">{a.name || t('agentUnknown')}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-foreground">{a.registered}</td>
                          <td className="py-2 text-right tabular-nums text-foreground">
                            {a.avgMinutes === null ? '—' : formatDuration(a.avgMinutes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-3 text-xs text-muted-foreground">{t('agentsHint')}</p>
              </div>
            </div>

            {data.days.length > 1 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">{t('day')}</th>
                      <th className="py-2 pr-4 text-right font-medium">{t('incoming')}</th>
                      <th className="py-2 pr-4 text-right font-medium">{t('byAi')}</th>
                      <th className="py-2 text-right font-medium">{t('byHuman')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.days].reverse().map((d) => (
                      <tr key={d.day} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4 text-foreground">{d.day}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-foreground">{d.incoming}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-foreground">{d.byAi}</td>
                        <td className="py-2 text-right tabular-nums text-foreground">{d.byHuman}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
