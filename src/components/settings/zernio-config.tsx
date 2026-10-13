'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, Trash2, Eye, EyeOff, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

interface ZernioState {
  configured: boolean;
  zernioAccountId?: string;
  webhookUrl?: string | null;
}

/**
 * Connect the account's WhatsApp through Zernio instead of a Meta app.
 * The admin pastes the Zernio API key and the id of the WhatsApp
 * account connected in Zernio; the server verifies both, registers our
 * webhook there and stores the key encrypted. The key is never shown
 * again.
 */
export function ZernioConfigCard() {
  const t = useTranslations('Settings.zernio');
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<ZernioState>({ configured: false });
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [zernioAccountId, setZernioAccountId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zernio/config');
      const data = await res.json();
      if (data.configured) {
        setState({
          configured: true,
          zernioAccountId: data.zernio_account_id,
          webhookUrl: data.webhook_url,
        });
        setZernioAccountId(data.zernio_account_id ?? '');
      } else {
        setState({ configured: false });
      }
    } catch {
      setState({ configured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (accountId) void load();
  }, [accountId, load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/zernio/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey.trim(),
          zernio_account_id: zernioAccountId.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      if (data.account?.inbound_webhook_subscribed === false) {
        toast.warning(t('notSubscribed'));
      }
      setApiKey('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/zernio/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnected'));
      setApiKey('');
      setZernioAccountId('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const copyUrl = async () => {
    if (!state.webhookUrl) return;
    await navigator.clipboard.writeText(state.webhookUrl);
    toast.success(t('copied'));
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('title')}
          {state.configured ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label={t('connected')} />
          ) : null}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {state.configured && state.webhookUrl ? (
              <div className="space-y-1">
                <Label>{t('webhookUrl')}</Label>
                <div className="flex gap-2">
                  <Input readOnly value={state.webhookUrl} className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={copyUrl}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('webhookHint')}</p>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="zernio-account">{t('accountId')}</Label>
              <Input
                id="zernio-account"
                value={zernioAccountId}
                onChange={(e) => setZernioAccountId(e.target.value)}
                disabled={!canEdit}
                placeholder={t('accountIdPlaceholder')}
              />
              <p className="text-xs text-muted-foreground">{t('accountIdHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="zernio-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <Input
                  id="zernio-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!canEdit}
                  placeholder={state.configured ? t('keyStoredPlaceholder') : 'sk_...'}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? t('hideKey') : t('showKey')}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {canEdit ? (
              <div className="flex gap-2">
                <Button
                  onClick={handleSave}
                  disabled={saving || !apiKey.trim() || !zernioAccountId.trim()}
                >
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {state.configured ? t('update') : t('connect')}
                </Button>
                {state.configured ? (
                  <Button variant="outline" onClick={handleDisconnect} disabled={saving}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('disconnect')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
