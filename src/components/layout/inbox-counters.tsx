"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { formatNumber } from "@/lib/currency";
import { loadInboxCounts, type InboxCounts } from "@/lib/inbox/counts";

const REFRESH_MS = 20_000;

/**
 * The two inbox numbers, on the right of the page title:
 *   - "Mensajes sin respuesta cliente": pending conversations (we spoke last,
 *     the customer has not answered);
 *   - "Mensajes sin respuesta de Intertec": open conversations (the customer
 *     wrote and nobody has answered yet).
 * Each person sees the totals of the conversations she can open: her own
 * for an advisor, the whole account for an admin.
 */
export function InboxCounters() {
  const t = useTranslations("Header");
  const [counts, setCounts] = useState<InboxCounts | null>(null);

  useEffect(() => {
    let cancelled = false;
    const db = createClient();
    const refresh = () => {
      loadInboxCounts(db)
        .then((c) => {
          if (!cancelled) setCounts(c);
        })
        // Keep the last numbers on a failed refresh.
        .catch((err) => console.error("[inbox counters] failed:", err));
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!counts) return null;

  return (
    <div
      className="flex flex-col items-end text-[11px] leading-tight text-muted-foreground sm:flex-row sm:items-center sm:gap-4 sm:text-xs"
      aria-live="polite"
    >
      <span title={t("unansweredCustomerHint")}>
        {t("unansweredCustomer")}:{" "}
        <b className="tabular-nums text-foreground">{formatNumber(counts.pending)}</b>
      </span>
      <span title={t("unansweredCompanyHint")}>
        {t("unansweredCompany")}:{" "}
        <b className="tabular-nums text-foreground">{formatNumber(counts.open)}</b>
      </span>
    </div>
  );
}
