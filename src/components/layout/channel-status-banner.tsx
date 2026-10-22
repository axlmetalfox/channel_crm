"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { WifiOff } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";

const REFRESH_MS = 60_000;

interface ConnectionState {
  status: string;
  down_since: string | null;
}

/**
 * A red bar above every page while the WhatsApp number is disconnected: nothing
 * comes in and every send fails, so advisors should not keep retrying and
 * the admin should act. Fed by the 5-minute sweep (see /api/whatsapp/connection).
 */
export function ChannelStatusBanner() {
  const t = useTranslations("ChannelStatus");
  const { accountRole } = useAuth();
  const [state, setState] = useState<ConnectionState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/whatsapp/connection", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { configured?: boolean; status?: string; down_since?: string | null };
        if (!cancelled && data.configured && data.status) {
          setState({ status: data.status, down_since: data.down_since ?? null });
        }
      } catch {
        // keep the last known state
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!state || state.status !== "disconnected") return null;

  const since = state.down_since
    ? new Date(state.down_since).toLocaleString("es-CO", {
        timeZone: "America/Bogota",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const isAdmin = !!accountRole && canEditSettings(accountRole);

  return (
    <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-500">
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">{t("title")}</p>
        <p className="text-red-500/90">
          {since ? t("bodySince", { since }) : t("body")}
          {" "}
          {isAdmin ? t("adminHint") : t("agentHint")}
        </p>
      </div>
    </div>
  );
}
