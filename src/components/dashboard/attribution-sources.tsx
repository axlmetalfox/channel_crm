"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Image as ImageIcon, Megaphone, Newspaper, Route, Video } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { formatCurrency, formatNumber } from "@/lib/currency";
import { localDayKey } from "@/lib/dashboard/date-utils";
import { PRESETS, presetRange } from "@/lib/dashboard/date-range";
import {
  groupByCreative,
  loadAttributionSummary,
  type AttributionSource,
  type AttributionSummary,
  type CampaignSummary,
} from "@/lib/dashboard/attribution";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";

type View = "ad" | "creative" | "campaign";

/**
 * "Fuentes de Atribución": every Meta ad or post that started a conversation,
 * with how many conversations it brought, how many ended in a lead sent to
 * the CRM, and the conversion rate. Account-wide, so only admins, the owner
 * and observers see it (advisors only see their own numbers elsewhere).
 */
export function AttributionSourcesPanel() {
  const t = useTranslations("Dashboard.attribution");
  const { accountRole, profileLoading } = useAuth();
  const canSee = !!accountRole && (canEditSettings(accountRole) || accountRole === "viewer");

  const [initialRange] = useState(() => presetRange("30"));
  const [range, setRange] = useState(initialRange);
  const [data, setData] = useState<AttributionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>("ad");

  const fetchRange = useCallback((from: string, to: string) => {
    loadAttributionSummary(createClient(), from, to)
      .then(setData)
      .catch((err) => {
        console.error("[dashboard] attribution failed:", err);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (profileLoading || !canSee) return;
    fetchRange(initialRange.from, initialRange.to);
  }, [profileLoading, canSee, fetchRange, initialRange]);

  const select = (next: { from: string; to: string }) => {
    setRange(next);
    setLoading(true);
    setFailed(false);
    fetchRange(next.from, next.to);
  };

  const change = (patch: Partial<{ from: string; to: string }>) => {
    const next = { ...range, ...patch };
    if (!next.from || !next.to) return;
    if (next.from > next.to) {
      if (patch.from) next.to = next.from;
      else next.from = next.to;
    }
    select(next);
  };

  const cards = useMemo(() => {
    if (!data) return [];
    return view === "creative" ? groupByCreative(data.sources) : data.sources;
  }, [data, view]);

  const percent = (rate: number) => `${formatNumber(rate * 100, 1)}%`;
  const perf = data?.performance ?? null;
  const money = (value: number) => formatCurrency(value, perf?.currency ?? "COP");
  const today = localDayKey(new Date());

  if (profileLoading || !canSee) return null;

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Route className="h-4 w-4 text-primary" />
            {t("title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {PRESETS.map((p) => {
              const r = presetRange(p);
              const active = r.from === range.from && r.to === range.to;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => select(r)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`preset.${p}`)}
                </button>
              );
            })}
          </div>
          <label className="text-xs text-muted-foreground">
            {t("from")}
            <input
              type="date"
              value={range.from}
              max={today}
              onChange={(e) => change({ from: e.target.value })}
              className="mt-1 block h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            {t("to")}
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
          <p className="text-sm text-destructive">{t("loadError")}</p>
        ) : loading || !data ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {/* Totals */}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Total label={t("totalConversations")} value={formatNumber(data.total.conversations)} />
              <Total label={t("fromMeta")} value={formatNumber(data.attributed.conversations)} hint={t("fromMetaHint", { count: formatNumber(data.sources.length) })} />
              <Total label={t("leadsToZoho")} value={formatNumber(data.attributed.leads)} hint={t("ofMeta")} />
              <Total label={t("rate")} value={percent(data.attributed.rate)} hint={t("ofMeta")} />
            </dl>
            {perf && (
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Total label={t("spend")} value={money(perf.spend)} hint={t("spendHint")} />
                <Total
                  label={t("costPerConversation")}
                  value={perf.costPerConversation === null ? "—" : money(perf.costPerConversation)}
                  hint={t("ofAds")}
                />
                <Total
                  label={t("costPerLead")}
                  value={perf.costPerLead === null ? "—" : money(perf.costPerLead)}
                  hint={t("ofAds")}
                />
                <Total label={t("idleSpend")} value={money(perf.idleSpend)} hint={t("idleSpendHint")} />
              </dl>
            )}

            {/* View switch */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
                {((perf ? ["campaign", "ad", "creative"] : ["ad", "creative"]) as View[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      view === v ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`view_${v}`)}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{perf ? t("syncedNote") : t("campaignNote")}</p>
            </div>

            {view === "campaign" && perf ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {perf.campaigns.map((c) => (
                  <CampaignCard key={c.key} campaign={c} maxSpend={perf.campaigns[0]?.spend ?? 1} t={t} percent={percent} money={money} />
                ))}
                {data.direct && (
                  <SourceCard source={data.direct} maxConversations={data.direct.conversations} t={t} percent={percent} money={money} />
                )}
              </div>
            ) : cards.length === 0 && !data.direct ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {cards.map((s) => (
                  <SourceCard key={s.key} source={s} maxConversations={cards[0]?.conversations ?? 1} t={t} percent={percent} money={money} />
                ))}
                {data.direct && (
                  <SourceCard source={data.direct} maxConversations={cards[0]?.conversations ?? data.direct.conversations} t={t} percent={percent} money={money} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Total({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">{value}</dd>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SourceCard({
  source,
  maxConversations,
  t,
  percent,
  money,
}: {
  source: AttributionSource;
  maxConversations: number;
  t: ReturnType<typeof useTranslations>;
  percent: (rate: number) => string;
  money: (value: number) => string;
}) {
  const Icon = source.kind === "post" ? Newspaper : source.kind === "direct" ? Route : Megaphone;
  const MediaIcon = source.mediaType === "video" ? Video : ImageIcon;
  const title =
    source.kind === "direct"
      ? t("directTitle")
      : source.headline || t("noHeadline", { id: source.sourceIds[0] ?? "" });
  const share = maxConversations > 0 ? Math.max(3, Math.round((source.conversations / maxConversations) * 100)) : 0;

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border p-4",
        source.kind === "direct" ? "bg-muted/30" : "bg-background",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
            source.kind === "post"
              ? "bg-emerald-500/10 text-emerald-500"
              : source.kind === "direct"
                ? "bg-muted text-muted-foreground"
                : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-3 w-3" />
          {t(`kind_${source.kind}`)}
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          {source.kind !== "direct" && source.mediaType && <MediaIcon className="h-3.5 w-3.5" aria-label={source.mediaType} />}
          {source.url && (
            <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={t("openSource")} title={t("openSource")} className="hover:text-foreground">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      </div>

      <div className="min-h-10">
        <h3 className="line-clamp-2 text-sm font-medium text-foreground" title={title}>
          {title}
        </h3>
        {source.campaignName && (
          <p className="mt-0.5 truncate text-[11px] text-foreground/80" title={source.campaignName}>
            {t("campaignLabel")}: {source.campaignName}
            {source.adSetName ? ` · ${source.adSetName}` : ""}
          </p>
        )}
        {source.sourceIds.length > 0 && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={source.sourceIds.join(", ")}>
            {source.sourceIds.length > 1 ? t("adsCount", { count: source.sourceIds.length }) : `ID ${source.sourceIds[0]}`}
          </p>
        )}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${share}%` }} />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <div>
          <dd className="text-lg font-semibold tabular-nums text-foreground">{formatNumber(source.conversations)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("conversations")}</dt>
        </div>
        <div>
          <dd className="text-lg font-semibold tabular-nums text-foreground">{formatNumber(source.leads)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("leads")}</dt>
        </div>
        <div>
          <dd className="text-lg font-semibold tabular-nums text-primary">{percent(source.rate)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("conversion")}</dt>
        </div>
      </dl>

      {source.spend !== null && (
        <dl className="grid grid-cols-3 gap-2 border-t border-border pt-2 text-center">
          <Money label={t("spend")} value={money(source.spend)} />
          <Money
            label={t("perConversation")}
            value={source.conversations > 0 ? money(source.spend / source.conversations) : "—"}
          />
          <Money label={t("perLead")} value={source.leads > 0 ? money(source.spend / source.leads) : "—"} />
        </dl>
      )}
    </article>
  );
}

function Money({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="text-sm font-medium tabular-nums text-foreground">{value}</dd>
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
    </div>
  );
}

function CampaignCard({
  campaign,
  maxSpend,
  t,
  percent,
  money,
}: {
  campaign: CampaignSummary;
  maxSpend: number;
  t: ReturnType<typeof useTranslations>;
  percent: (rate: number) => string;
  money: (value: number) => string;
}) {
  const title =
    campaign.kind === "organic"
      ? t("organicCampaign")
      : campaign.kind === "unknown"
        ? t("unknownCampaign")
        : campaign.name || t("noHeadline", { id: campaign.key });
  const share = maxSpend > 0 ? Math.max(3, Math.round((campaign.spend / maxSpend) * 100)) : 0;
  const active = campaign.status === "active";

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          <Megaphone className="h-3 w-3" />
          {t("kind_campaign")}
        </span>
        {campaign.kind === "campaign" && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              active ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground",
            )}
          >
            {active ? t("statusActive") : t("statusInactive")}
          </span>
        )}
      </div>

      <div className="min-h-10">
        <h3 className="line-clamp-2 text-sm font-medium text-foreground" title={title}>
          {title}
        </h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{t("adsInCampaign", { count: campaign.ads })}</p>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${share}%` }} />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <div>
          <dd className="text-lg font-semibold tabular-nums text-foreground">{formatNumber(campaign.conversations)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("conversations")}</dt>
        </div>
        <div>
          <dd className="text-lg font-semibold tabular-nums text-foreground">{formatNumber(campaign.leads)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("leads")}</dt>
        </div>
        <div>
          <dd className="text-lg font-semibold tabular-nums text-primary">{percent(campaign.rate)}</dd>
          <dt className="text-[10px] text-muted-foreground">{t("conversion")}</dt>
        </div>
      </dl>

      {campaign.kind !== "organic" && (
        <dl className="grid grid-cols-3 gap-2 border-t border-border pt-2 text-center">
          <Money label={t("spend")} value={money(campaign.spend)} />
          <Money
            label={t("perConversation")}
            value={campaign.costPerConversation === null ? "—" : money(campaign.costPerConversation)}
          />
          <Money label={t("perLead")} value={campaign.costPerLead === null ? "—" : money(campaign.costPerLead)} />
        </dl>
      )}
    </article>
  );
}
