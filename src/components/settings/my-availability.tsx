'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Each agent decides whether they are available to be given conversations
 * by the automatic assignment (away, on leave, busy). It only touches their
 * own setting and is saved as soon as it is switched.
 */
export function MyAvailabilityCard() {
  const t = useTranslations('Settings.myAvailability');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/assignment/agents');
      if (!res.ok) return;
      const data = await res.json();
      setEligible(data.eligible === true);
      setAvailable(data.available !== false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only people in the rotation (the agent role) have this setting.
  if (loading || !eligible) return null;

  const change = async (next: boolean) => {
    const previous = available;
    setAvailable(next);
    setSaving(true);
    try {
      const res = await fetch('/api/account/assignment/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ available: next }),
      });
      if (!res.ok) throw new Error('save failed');
      toast.success(next ? t('savedOn') : t('savedOff'));
    } catch {
      setAvailable(previous);
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
      <CardContent>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t('toggle')}</p>
            <p className="text-xs text-muted-foreground">
              {available ? t('onHint') : t('offHint')}
            </p>
          </div>
          <Switch checked={available} onCheckedChange={change} disabled={saving} />
          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </CardContent>
    </Card>
  );
}
