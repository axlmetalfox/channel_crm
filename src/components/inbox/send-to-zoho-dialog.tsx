"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Info, Loader2, Lock, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ============================================================
// "Send to Zoho": an agent finishes a stalled conversation by hand.
// Opened by the /enviarZoho command or the thread header button. The
// server reads the chat and proposes the lead; the agent reviews and
// reviews it here; confirming sends it like an AI-captured lead, marked as
// registered from TUYO CRM by that agent.
//
// The customer's data is read-only: it must come from the customer. If the
// chat is missing something, the agent asks the customer and re-reads the
// chat. A wrong reading can be corrected, but the server only accepts a
// value the customer wrote. Notes are free text.
// ============================================================

const REQUEST_TYPES = [
  "maquina_nueva",
  "info_maquina",
  "alquiler",
  "repuestos",
  "servicio_tecnico",
] as const;

interface LeadForm {
  first_name: string;
  last_name: string;
  email: string;
  company: string;
  document_id: string;
  whatsapp_number: string;
  contact_phone: string;
  country: string;
  city: string;
  request_summary: string;
  request_type: string;
  notes: string;
}

/** Details an agent cannot send without. */
const REQUIRED: (keyof LeadForm)[] = [
  "first_name",
  "last_name",
  "whatsapp_number",
  "email",
  "city",
];

interface Proposal {
  intake_id: string;
  lead: Record<string, string | null>;
  consent_given: boolean;
  already_delivered_at: string | null;
  known_in_crm: boolean;
}

const EMPTY: LeadForm = {
  first_name: "",
  last_name: "",
  email: "",
  company: "",
  document_id: "",
  whatsapp_number: "",
  contact_phone: "",
  country: "",
  city: "",
  request_summary: "",
  request_type: "maquina_nueva",
  notes: "",
};

function toForm(lead: Proposal["lead"]): LeadForm {
  const out = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof LeadForm)[]) {
    out[key] = lead[key] ?? EMPTY[key];
  }
  return out;
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  first_name: "firstName",
  last_name: "lastName",
  email: "email",
  company: "company",
  document_id: "documentId",
  whatsapp_number: "whatsapp",
  contact_phone: "contactPhone",
  country: "country",
  city: "city",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onSent?: () => void;
}

export function SendToZohoDialog({ open, onOpenChange, conversationId, onSent }: Props) {
  const t = useTranslations("Inbox.sendToZoho");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [form, setForm] = useState<LeadForm>(EMPTY);
  // The data fields are locked; "Correct a detail" unlocks them.
  const [correcting, setCorrecting] = useState(false);
  // Fields the server refused (not in the chat / missing).
  const [flagged, setFlagged] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const keepNotes = useRef(false);

  const errorText = useCallback(
    (code: string | undefined) => {
      switch (code) {
        case "no_messages":
          return t("errorNoMessages");
        case "ai_unavailable":
          return t("errorAiUnavailable");
        case "consent_required":
          return t("errorConsent");
        case "incomplete":
          return t("errorIncomplete");
        case "unverified_data":
          return t("errorUnverified");
        case "invalid_lead":
          return t("errorInvalid");
        case "already_submitted":
          return t("errorAlreadySent");
        default:
          return t("errorGeneric");
      }
    },
    [t],
  );

  // Ask the server to read the chat every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProposal(null);
    setFlagged([]);
    setCorrecting(false);
    (async () => {
      try {
        const res = await fetch("/api/leads/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(errorText(data?.code));
          return;
        }
        setProposal(data as Proposal);
        const keep = keepNotes.current;
        keepNotes.current = false;
        setForm((prev) => ({ ...toForm((data as Proposal).lead), notes: keep ? prev.notes : "" }));
      } catch {
        if (!cancelled) setError(errorText(undefined));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId, errorText, reloadKey]);

  const set = (key: keyof LeadForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const missing = REQUIRED.filter((key) => !form[key].trim());
  const canSend =
    !!proposal &&
    proposal.consent_given &&
    !sending &&
    missing.length === 0 &&
    form.request_summary.trim().length > 0;

  const reread = () => {
    keepNotes.current = true;
    setReloadKey((k) => k + 1);
  };

  const handleSend = async () => {
    if (!proposal) return;
    setSending(true);
    try {
      const res = await fetch("/api/leads/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intake_id: proposal.intake_id, lead: form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(data?.fields)) {
          setFlagged(data.fields as string[]);
          if (data?.code === "unverified_data") setCorrecting(true);
        }
        toast.error(errorText(data?.code));
        return;
      }
      toast.success(data?.status === "delivered" ? t("sent") : t("queued"));
      onOpenChange(false);
      onSent?.();
    } catch {
      toast.error(errorText(undefined));
    } finally {
      setSending(false);
    }
  };

  const field = (key: keyof LeadForm, label: string, type = "text") => {
    const required = REQUIRED.includes(key);
    const isFlagged = flagged.includes(key);
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`zoho-${key}`}>
          {label}
          {required && <span className="text-red-400"> *</span>}
        </Label>
        <Input
          id={`zoho-${key}`}
          type={type}
          value={form[key]}
          onChange={(e) => {
            set(key)(e.target.value);
            setFlagged((f) => f.filter((k) => k !== key));
          }}
          readOnly={!correcting}
          disabled={sending}
          aria-invalid={isFlagged || (required && !form[key].trim())}
          className={
            isFlagged
              ? "border-red-500"
              : !correcting
                ? "bg-muted/50 text-foreground"
                : undefined
          }
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("reading")}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {proposal && (
          <div className="space-y-4">
            {!proposal.consent_given && (
              <div className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{t("noConsent")}</span>
              </div>
            )}
            {proposal.already_delivered_at && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {t("alreadySent", {
                    date: new Date(proposal.already_delivered_at).toLocaleString(),
                  })}
                </span>
              </div>
            )}
            {proposal.known_in_crm && (
              <div className="flex gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{t("knownInCrm")}</span>
              </div>
            )}

            <div className="flex gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{t("dataFromCustomer")}</span>
            </div>

            {missing.length > 0 && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {t("missingFields", {
                    fields: missing.map((k) => t(FIELD_LABEL_KEYS[k])).join(", "),
                  })}
                </span>
              </div>
            )}

            {flagged.length > 0 && (
              <div className="flex gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  {t("flaggedFields", {
                    fields: flagged.map((k) => t(FIELD_LABEL_KEYS[k] ?? k)).join(", "),
                  })}
                </span>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={reread} disabled={sending || loading}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t("reread")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCorrecting((c) => !c)}
                disabled={sending}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {correcting ? t("lockData") : t("correctData")}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {field("first_name", t("firstName"))}
              {field("last_name", t("lastName"))}
              {field("email", t("email"), "email")}
              {field("company", t("company"))}
              {field("document_id", t("documentId"))}
              {field("whatsapp_number", t("whatsapp"))}
              {field("contact_phone", t("contactPhone"))}
              {field("country", t("country"))}
              {field("city", t("city"))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="zoho-request_type">{t("requestType")}</Label>
              <select
                id="zoho-request_type"
                value={form.request_type}
                onChange={(e) => set("request_type")(e.target.value)}
                disabled={sending}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                {REQUEST_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`type_${value}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="zoho-request_summary">{t("requestSummary")}</Label>
              <Textarea
                id="zoho-request_summary"
                rows={3}
                value={form.request_summary}
                onChange={(e) => set("request_summary")(e.target.value)}
                disabled={sending}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="zoho-notes">{t("notes")}</Label>
              <Textarea
                id="zoho-notes"
                rows={3}
                maxLength={2000}
                placeholder={t("notesPlaceholder")}
                value={form.notes}
                onChange={(e) => set("notes")(e.target.value)}
                disabled={sending}
              />
              <p className="text-xs text-muted-foreground">{t("notesHint")}</p>
            </div>

            <p className="text-xs text-muted-foreground">{t("registeredNote")}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSend} disabled={!canSend}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
