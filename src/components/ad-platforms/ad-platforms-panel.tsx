'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Megaphone,
  RefreshCw,
  Search,
  Sparkles,
  Music2,
  Plug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ProviderId, ProviderStatus } from '@/lib/ad-platforms/providers';

const POLL_MS = 3000;
const POLL_MAX_MS = 5 * 60_000;

const ICONS: Record<ProviderId, typeof Megaphone> = {
  meta: Megaphone,
  google: Search,
  tiktok: Music2,
  openai: Sparkles,
};

type Step = 'intro' | 'waiting' | 'done' | 'failed';

export function AdPlatformsPanel({ returnedFromSignIn }: { returnedFromSignIn: boolean }) {
  const t = useTranslations('AdPlatforms');
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<'ok' | 'failed' | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (): Promise<ProviderStatus[] | null> => {
    try {
      const res = await fetch('/api/ad-platforms', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { providers: ProviderStatus[] };
      setProviders(data.providers);
      setLoadError(false);
      return data.providers;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => {
    void load();
    return stopPolling;
  }, [load, stopPolling]);

  // The sign-in window lands back here. Inside the popup this page only has to
  // close itself; when it was a full-page redirect (popup blocked) it shows the
  // result instead.
  useEffect(() => {
    if (!returnedFromSignIn) return;
    if (window.opener && window.opener !== window) {
      window.close();
      return;
    }
    setOpen(true);
    setStep('waiting');
    void load().then((list) => {
      const meta = list?.find((p) => p.id === 'meta');
      setStep(meta?.state === 'connected' ? 'done' : 'failed');
    });
  }, [returnedFromSignIn, load]);

  const meta = providers?.find((p) => p.id === 'meta') ?? null;

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch('/api/ad-platforms/sync', { method: 'POST' });
      setSyncMessage(res.ok ? 'ok' : 'failed');
      await load();
    } catch {
      setSyncMessage('failed');
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const startPolling = useCallback(() => {
    stopPolling();
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      const list = await load();
      const current = list?.find((p) => p.id === 'meta');
      if (current?.state === 'connected') {
        stopPolling();
        try {
          popupRef.current?.close();
        } catch {
          // the window may already be gone
        }
        setStep('done');
        // Bring the ads in right away so the dashboard shows campaigns and spend.
        void syncNow();
      } else if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling();
        setStep('failed');
      }
    }, POLL_MS);
  }, [load, stopPolling, syncNow]);

  function openDialog() {
    setErrorCode(null);
    setStep('intro');
    setOpen(true);
  }

  function closeDialog() {
    stopPolling();
    setOpen(false);
    setBusy(false);
  }

  async function connect() {
    setBusy(true);
    setErrorCode(null);
    // Open the window now, while the click is still fresh, so the browser does
    // not block it; the address is filled in once we have it.
    const popup = window.open('about:blank', 'ad-platform-connect', 'width=640,height=780');
    popupRef.current = popup;
    try {
      const res = await fetch('/api/ad-platforms/meta/connect', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as { authUrl?: string; code?: string };
      if (!res.ok || !data.authUrl) {
        popup?.close();
        setErrorCode(data.code ?? 'connect_failed');
        setStep('failed');
        return;
      }
      if (popup) {
        popup.location.href = data.authUrl;
        setStep('waiting');
        startPolling();
      } else {
        // Pop-ups are blocked: continue in this tab, the sign-in brings us back.
        window.location.href = data.authUrl;
      }
    } catch {
      popup?.close();
      setErrorCode('connect_failed');
      setStep('failed');
    } finally {
      setBusy(false);
    }
  }

  function stateBadge(status: ProviderStatus) {
    switch (status.state) {
      case 'connected':
        return (
          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 /> {t('stateConnected')}
          </Badge>
        );
      case 'needs_reconnect':
        return (
          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
            <AlertTriangle /> {t('stateNeedsReconnect')}
          </Badge>
        );
      case 'coming_soon':
        return <Badge variant="secondary">{t('stateComingSoon')}</Badge>;
      default:
        return <Badge variant="outline">{t('stateNotConnected')}</Badge>;
    }
  }

  const formatter = new Intl.NumberFormat('es-CO');

  return (
    <>
      {loadError && (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t('loadError')}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            {t('retry')}
          </button>
        </div>
      )}

      {!providers && !loadError && (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
        </div>
      )}

      {providers && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {providers.map((p) => {
            const Icon = ICONS[p.id];
            const available = p.state !== 'coming_soon';
            return (
              <div
                key={p.id}
                className="flex flex-col rounded-lg border bg-card p-4 shadow-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-5 w-5 text-foreground" />
                    </span>
                    <div>
                      <p className="font-medium text-foreground">{t(`providers.${p.id}.name`)}</p>
                      <p className="text-xs text-muted-foreground">{t(`providers.${p.id}.tagline`)}</p>
                    </div>
                  </div>
                  {stateBadge(p)}
                </div>

                {p.connection && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {p.connection.name}
                    {p.connection.adAccounts.length > 0 &&
                      ` · ${t('adAccountsCount', { count: p.connection.adAccounts.length })}`}
                    {p.connection.adsCount > 0 &&
                      ` · ${t('adsCount', { count: formatter.format(p.connection.adsCount) })}`}
                  </p>
                )}

                <div className="mt-4 flex-1" />
                {available ? (
                  <Button
                    size="sm"
                    variant={p.state === 'connected' ? 'outline' : 'default'}
                    onClick={openDialog}
                  >
                    {p.state === 'connected'
                      ? t('manage')
                      : p.state === 'needs_reconnect'
                        ? t('reconnect')
                        : t('connect')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled>
                    {t('stateComingSoon')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : closeDialog())}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogSubtitle')}</DialogDescription>
          </DialogHeader>

          {step === 'intro' && (
            <div className="space-y-4">
              {meta?.state === 'connected' && meta.connection ? (
                <ConnectedSummary status={meta} t={t} formatter={formatter} />
              ) : meta?.state === 'needs_reconnect' ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                  {t('needsReconnectHelp')}
                </div>
              ) : null}

              <ol className="space-y-3 text-sm">
                {[1, 2, 3].map((n) => (
                  <li key={n} className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {n}
                    </span>
                    <span className="pt-0.5 text-foreground">{t(`onboarding.step${n}`)}</span>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted-foreground">{t('onboarding.permissions')}</p>
            </div>
          )}

          {step === 'waiting' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="font-medium text-foreground">{t('waitingTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('waitingHelp')}</p>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-600" />
                <p className="font-medium text-foreground">{t('doneTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('doneHelp')}</p>
              </div>
              {meta?.connection && <ConnectedSummary status={meta} t={t} formatter={formatter} />}
            </div>
          )}

          {step === 'intro' && meta?.state === 'connected' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3 text-xs">
              <span className="text-muted-foreground">
                {meta.connection?.sync?.lastError
                  ? t('syncError')
                  : meta.connection?.sync?.lastSyncedAt
                    ? t('lastSync', { when: new Date(meta.connection.sync.lastSyncedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) })
                    : t('neverSynced')}
                {syncMessage === 'ok' && ` · ${t('syncOk')}`}
                {syncMessage === 'failed' && ` · ${t('syncFailed')}`}
              </span>
              <Button size="sm" variant="outline" disabled={syncing} onClick={() => void syncNow()}>
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {syncing ? t('syncing') : t('syncNow')}
              </Button>
            </div>
          )}

          {step === 'failed' && (
            <div className="space-y-2 py-2 text-center">
              <AlertTriangle className="mx-auto h-8 w-8 text-amber-600" />
              <p className="font-medium text-foreground">{t('failedTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {errorCode === 'no_site_url' ? t('failedNoSite') : t('failedHelp')}
              </p>
            </div>
          )}

          <DialogFooter>
            {step === 'intro' && (
              <>
                <Button variant="outline" onClick={closeDialog}>
                  {t('close')}
                </Button>
                <Button onClick={() => void connect()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                  {meta?.state === 'connected' ? t('reconnect') : meta?.state === 'needs_reconnect' ? t('reconnect') : t('connect')}
                </Button>
              </>
            )}
            {step === 'waiting' && (
              <Button variant="outline" onClick={closeDialog}>
                {t('cancel')}
              </Button>
            )}
            {step === 'done' && <Button onClick={closeDialog}>{t('close')}</Button>}
            {step === 'failed' && (
              <>
                <Button variant="outline" onClick={closeDialog}>
                  {t('close')}
                </Button>
                <Button onClick={() => setStep('intro')}>
                  <RefreshCw className="h-4 w-4" /> {t('tryAgain')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectedSummary({
  status,
  t,
  formatter,
}: {
  status: ProviderStatus;
  t: ReturnType<typeof useTranslations>;
  formatter: Intl.NumberFormat;
}) {
  const c = status.connection;
  if (!c) return null;
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <Plug className="h-4 w-4" /> {c.name}
      </div>
      {c.adAccounts.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
          <span>
            {a.name}
            {a.currency ? ` (${a.currency})` : ''}
          </span>
          <span>{a.accountStatus === 1 ? t('accountActive') : a.unusableReason ?? t('accountInactive')}</span>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t('adsCount', { count: formatter.format(c.adsCount) })}</p>
    </div>
  );
}
