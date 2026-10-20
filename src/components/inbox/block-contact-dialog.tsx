"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { BLOCK_REASONS, type BlockReason, type WhatsAppBlockOutcome } from "@/lib/contacts/block-reasons";
import { blockContact } from "@/lib/contacts/block-api";

interface BlockContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactLabel: string;
  /** Pre-selected reason (e.g. "offensive" when opened from a flagged photo). */
  defaultReason?: BlockReason;
  onBlocked: (reason: BlockReason, note: string) => void;
}

/** How the WhatsApp side of the block went, as a short message for the person. */
export function whatsappOutcomeKey(outcome: WhatsAppBlockOutcome): string {
  switch (outcome) {
    case "done":
      return "outcomeDone";
    case "window_expired":
      return "outcomeWindowExpired";
    case "no_number":
      return "outcomeNoNumber";
    case "no_channel":
      return "outcomeNoChannel";
    default:
      return "outcomeFailed";
  }
}

export function BlockContactDialog({
  open,
  onOpenChange,
  contactId,
  contactLabel,
  defaultReason = "offensive",
  onBlocked,
}: BlockContactDialogProps) {
  const t = useTranslations("Inbox.block");
  const [reason, setReason] = useState<BlockReason>(defaultReason);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const outcome = await blockContact(contactId, reason, note);
      const detail = t(whatsappOutcomeKey(outcome));
      if (outcome === "done") toast.success(`${t("blocked", { name: contactLabel })} ${detail}`);
      else toast.warning(`${t("blocked", { name: contactLabel })} ${detail}`);
      onBlocked(reason, note.trim());
      setNote("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("error"));
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />
            {t("title", { name: contactLabel })}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5" role="group" aria-label={t("reasonLabel")}>
            <p className="text-sm font-medium text-foreground">{t("reasonLabel")}</p>
            <div className="flex flex-wrap gap-2">
              {BLOCK_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    reason === r
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t(`reason_${r}`)}
                </button>
              ))}
            </div>
          </div>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t("notePlaceholder")}
            className="min-h-20"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
