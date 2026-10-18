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
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type Unit = 'minutes' | 'hours';

const MAX_CHARS = 500;

/** Show whole hours as hours, anything else as minutes. */
function toDisplay(minutes: number): { value: number; unit: Unit } {
  return minutes >= 60 && minutes % 60 === 0
    ? { value: minutes / 60, unit: 'hours' }
    : { value: minutes, unit: 'minutes' };
}

/**
 * "If after N minutes or hours the customer has not answered, send the
 * following message": one short nudge the admin writes, sent by the agent
 * to bring a quiet customer back.
 */
export function RecoveryMessageCard() {
  const t = useTranslations('Settings.recovery');
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [value, setValue] = useState('2');
  const [unit, setUnit] = useState<Unit>('hours');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/recovery');
      if (!res.ok) return;
      const data = await res.json();
      if (data.configured === false) {
        setConfigured(false);
        return;
      }
      const shown = toDisplay(data.after_minutes ?? 120);
      setEnabled(data.enabled === true);
      setValue(String(shown.value));
      setUnit(shown.unit);
      setMessage(data.message ?? '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canEdit) return null;

  const errorFor = (code: string | undefined, fallback: string | undefined) => {
    switch (code) {
      case 'invalid_wait':
        return t('errorWait');
      case 'message_required':
        return t('errorMessageRequired');
      case 'message_too_long':
        return t('errorMessageLong');
      case 'not_configured':
        return t('errorNotConfigured');
      default:
        return fallback ?? t('saveFailed');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, value: Number(value), unit, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorFor(data.code, undefined));
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
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : !configured ? (
          <p className="text-sm text-muted-foreground">{t('needsAgent')}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enable')}</p>
                <p className="text-xs text-muted-foreground">{t('enableDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-2">
              <p className="text-sm text-foreground">{t('sentence')}</p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="recovery-after">{t('after')}</Label>
                  <Input
                    id="recovery-after"
                    type="number"
                    min={1}
                    step={1}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="w-28"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recovery-unit">{t('unit')}</Label>
                  <select
                    id="recovery-unit"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as Unit)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    <option value="minutes">{t('minutes')}</option>
                    <option value="hours">{t('hours')}</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="recovery-message">{t('message')}</Label>
              <Textarea
                id="recovery-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('messagePlaceholder')}
                rows={3}
                maxLength={MAX_CHARS}
              />
              <p className="text-xs text-muted-foreground">
                {message.length}/{MAX_CHARS}
              </p>
            </div>

            <p className="text-xs text-muted-foreground">{t('rules')}</p>

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
