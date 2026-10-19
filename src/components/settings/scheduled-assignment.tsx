'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { formatNumber } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface AgentRow {
  user_id: string;
  name: string | null;
  available: boolean;
}

interface Scheduled {
  at: string | null;
  result: {
    ran_at: string;
    assigned: number;
    per_agent: Record<string, number>;
    reason?: 'no_agents' | 'nothing_to_assign' | 'error';
  } | null;
  eligible: number;
  agents: AgentRow[];
  after_minutes: number;
  max_age_days: number;
}

/** ISO instant -> the value a datetime-local input expects, in local time. */
function toInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "Assign everything that meets the inactivity rule, once, at a chosen
 * time": hands every open or pending conversation nobody owns out equally
 * among the available agents. The server runs it with its 5-minute sweep.
 */
export function ScheduledAssignmentCard() {
  const t = useTranslations('Settings.scheduledAssignment');
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<Scheduled | null>(null);
  const [when, setWhen] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/assignment/scheduled');
      if (!res.ok) return;
      const data = (await res.json()) as Scheduled;
      setInfo(data);
      setWhen(data.at ? toInputValue(data.at) : '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canEdit) return null;

  const save = async (at: string | null) => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/assignment/scheduled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data?.code === 'in_the_past'
            ? t('errorPast')
            : data?.code === 'too_far'
              ? t('errorFar')
              : data?.code === 'invalid_time'
                ? t('errorInvalid')
                : t('saveFailed'),
        );
        return;
      }
      toast.success(at ? t('scheduled') : t('cancelled'));
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const available = info?.agents.filter((a) => a.available) ?? [];
  const nameOf = (id: string) => info?.agents.find((a) => a.user_id === id)?.name ?? t('unknownAgent');
  const share =
    info && available.length > 0 ? Math.ceil(info.eligible / available.length) : 0;
  const result = info?.result ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading || !info ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
              <p>{t('preview', { count: formatNumber(info.eligible) })}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {available.length > 0
                  ? t('previewSplit', {
                      agents: available.map((a) => a.name ?? t('unknownAgent')).join(', '),
                      share: formatNumber(share),
                    })
                  : t('noAgents')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('rule', { minutes: info.after_minutes, days: info.max_age_days })}
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="scheduled-at">{t('when')}</Label>
                <Input
                  id="scheduled-at"
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="w-56"
                />
              </div>
              <Button
                onClick={() => save(new Date(when).toISOString())}
                disabled={saving || !when || Number.isNaN(new Date(when).getTime())}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {info.at ? t('reschedule') : t('schedule')}
              </Button>
              {info.at && (
                <Button variant="outline" onClick={() => save(null)} disabled={saving}>
                  {t('cancel')}
                </Button>
              )}
            </div>

            {info.at && (
              <p className="text-sm text-foreground">
                {t('pending', { date: new Date(info.at).toLocaleString() })}
              </p>
            )}

            {result && (
              <div className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium text-foreground">
                  {t('lastRun', { date: new Date(result.ran_at).toLocaleString() })}
                </p>
                {result.reason === 'error' ? (
                  <p className="mt-1 text-muted-foreground">{t('lastRunError')}</p>
                ) : result.assigned === 0 ? (
                  <p className="mt-1 text-muted-foreground">
                    {result.reason === 'no_agents' ? t('noAgents') : t('nothingToAssign')}
                  </p>
                ) : (
                  <ul className="mt-1 text-muted-foreground">
                    {Object.entries(result.per_agent).map(([id, n]) => (
                      <li key={id}>
                        {nameOf(id)}: {formatNumber(n)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
