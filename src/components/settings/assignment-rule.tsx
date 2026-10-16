'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type Unit = 'minutes' | 'hours';

/** Show whole hours as hours, anything else as minutes. */
function toDisplay(minutes: number): { value: number; unit: Unit } {
  return minutes >= 60 && minutes % 60 === 0
    ? { value: minutes / 60, unit: 'hours' }
    : { value: minutes, unit: 'minutes' };
}

/**
 * "Assign a conversation to a person after X of inactivity". The server
 * applies it every few minutes, giving stalled conversations to the
 * agents in turns (round robin).
 */
export function AssignmentRuleCard() {
  const t = useTranslations('Settings.assignment');
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [value, setValue] = useState('60');
  const [unit, setUnit] = useState<Unit>('minutes');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/assignment');
      if (!res.ok) return;
      const data = await res.json();
      const shown = toDisplay(data.after_minutes ?? 60);
      setEnabled(data.enabled === true);
      setValue(String(shown.value));
      setUnit(shown.unit);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canEdit) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, value: Number(value), unit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      const shown = toDisplay(data.after_minutes);
      setValue(String(shown.value));
      setUnit(shown.unit);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('roundRobin')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enable')}</p>
                <p className="text-xs text-muted-foreground">{t('enableDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="assign-after">{t('after')}</Label>
                <Input
                  id="assign-after"
                  type="number"
                  min={1}
                  step={1}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="w-28"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="assign-unit">{t('unit')}</Label>
                <select
                  id="assign-unit"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Unit)}
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  <option value="minutes">{t('minutes')}</option>
                  <option value="hours">{t('hours')}</option>
                </select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{t('note')}</p>

            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
