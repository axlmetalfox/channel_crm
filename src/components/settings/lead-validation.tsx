'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * "Validate chat data": when on, a lead an agent sends to the CRM by hand
 * must use data the customer wrote in the chat (read-only form). When off,
 * the agent can type any value. Saved as soon as it is switched.
 */
export function LeadValidationCard() {
  const t = useTranslations('Settings.leadValidation');
  const canEdit = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/lead-validation');
      if (!res.ok) return;
      const data = await res.json();
      setEnabled(data.enabled !== false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!canEdit) return null;

  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch('/api/account/lead-validation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error('save failed');
      toast.success(next ? t('savedOn') : t('savedOff'));
    } catch {
      setEnabled(previous);
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
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('toggle')}</p>
                <p className="text-xs text-muted-foreground">
                  {enabled ? t('onHint') : t('offHint')}
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={change} disabled={saving} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
