"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, ChevronUp, X, ListChecks, LayoutTemplate, Loader2, Layers } from "lucide-react";
import {
  DEFAULT_LIST_STATE,
  LIST_STATE_STORAGE_KEY,
  neighbourId,
  parseSavedListState,
} from "@/lib/inbox/list-state";
import { useConversationStages } from "@/hooks/use-conversation-stages";
import { toast } from "sonner";
import { bulkContactTag } from "@/lib/contacts/tag-api";
import { useCan } from "@/hooks/use-can";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TemplatePicker, type TemplateSendValues } from "./template-picker";
import { renderTemplateBody } from "@/lib/whatsapp/template-body";
import {
  BULK_SEND_GAP_MS,
  BULK_TEMPLATE_MAX,
  recipientName,
  runBulkTemplate,
  type BulkItem,
} from "@/lib/inbox/bulk-template";
import type { MessageTemplate } from "@/types";
import { formatDistanceToNow } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import { dateFnsLocale } from "@/lib/date-locale";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread" | "blocked";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
    { label: t("filterBlocked"), value: "blocked" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // The account's own stages: filter by one, and set one on many chats.
  const { stages, byId: stagesById } = useConversationStages();
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);

  // The filters and search survive a reload, a deploy or a remount (kept per
  // browser tab): the person working down the list never has to set them again.
  const [listStateRestored, setListStateRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = parseSavedListState(window.sessionStorage.getItem(LIST_STATE_STORAGE_KEY));
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFilter(saved.filter);
        setSearch(saved.search);
        setSelectedTagIds(saved.tagIds);
        setSelectedCompany(saved.company);
        setSelectedStageId(saved.stageId);
      }
    } catch {
      // storage unavailable: start from the defaults
    }
    setListStateRestored(true);
  }, []);
  useEffect(() => {
    if (!listStateRestored) return;
    try {
      window.sessionStorage.setItem(
        LIST_STATE_STORAGE_KEY,
        JSON.stringify({
          ...DEFAULT_LIST_STATE,
          filter,
          search,
          tagIds: selectedTagIds,
          company: selectedCompany,
          stageId: selectedStageId,
        }),
      );
    } catch {
      // storage unavailable: nothing to remember
    }
  }, [listStateRestored, filter, search, selectedTagIds, selectedCompany, selectedStageId]);
  const listRef = useRef<HTMLDivElement>(null);
  const lastActiveIndex = useRef(0);

  // Selection mode: tick conversations (or all the filtered ones) and add or
  // remove a tag on their contacts in one go.
  const canEditTags = useCan("send-messages");
  const [selecting, setSelecting] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // One approved template to every ticked conversation (re-engage quiet
  // customers): pick it, confirm the count, then it sends one by one.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [bulkPlan, setBulkPlan] = useState<{
    template: MessageTemplate;
    values: TemplateSendValues;
    items: BulkItem[];
  } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const bulkStop = useRef(false);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    // Blocked contacts have their own filter; everywhere else they stay out.
    let result =
      filter === "blocked"
        ? conversations.filter((c) => !!c.contact?.blocked_at)
        : conversations.filter((c) => !c.contact?.blocked_at);

    if (filter === "blocked") {
      // already narrowed above
    } else if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (selectedStageId !== null) {
      result = result.filter((c) => (selectedStageId === "none" ? !c.stage_id : c.stage_id === selectedStageId));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany, selectedStageId]);

  // Where the open conversation sits in what the person is looking at.
  const filteredIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const activeIndex = activeConversationId ? filteredIds.indexOf(activeConversationId) : -1;
  useEffect(() => {
    if (activeIndex >= 0) lastActiveIndex.current = activeIndex;
  }, [activeIndex]);

  const goTo = useCallback(
    (direction: 1 | -1) => {
      const id = neighbourId(filteredIds, activeConversationId, lastActiveIndex.current, direction);
      const target = id ? filtered.find((c) => c.id === id) : null;
      if (target) onSelect(target);
    },
    [filteredIds, filtered, activeConversationId, onSelect],
  );

  // Alt + ↓ / Alt + ↑ move to the next / previous conversation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      goTo(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo]);

  // Keep the open conversation in view: after a reload, or when moving with
  // the keys. ("nearest" leaves the list alone when it is already visible.)
  useEffect(() => {
    if (!activeConversationId || loading) return;
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-conv-id="${activeConversationId}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConversationId, loading]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const allFilteredChecked =
    filtered.length > 0 && filtered.every((c) => checkedIds.has(c.id));
  const someFilteredChecked = filtered.some((c) => checkedIds.has(c.id));

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllFiltered = useCallback(() => {
    setCheckedIds(
      allFilteredChecked ? new Set() : new Set(filtered.map((c) => c.id))
    );
  }, [allFilteredChecked, filtered]);

  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setCheckedIds(new Set());
  }, []);

  const handleTemplatePicked = useCallback(
    (template: MessageTemplate, values: TemplateSendValues) => {
      const items: BulkItem[] = conversations
        .filter((c) => checkedIds.has(c.id) && c.contact && !c.contact.blocked_at)
        .map((c) => ({ conversationId: c.id, name: recipientName(c.contact) }));
      if (items.length === 0) return;
      if (items.length > BULK_TEMPLATE_MAX) {
        toast.error(t("bulkTemplateTooMany", { max: BULK_TEMPLATE_MAX }));
        return;
      }
      setBulkPlan({ template, values, items });
    },
    [checkedIds, conversations, t]
  );

  const sendBulkTemplate = useCallback(async () => {
    if (!bulkPlan) return;
    const { template, values, items } = bulkPlan;
    bulkStop.current = false;
    setBulkProgress({ done: 0, total: items.length });
    const outcome = await runBulkTemplate({
      items,
      shouldStop: () => bulkStop.current,
      onProgress: (done, total) => setBulkProgress({ done, total }),
      send: async (item) => {
        // The first body variable is the customer's name; the rest are the
        // same for everyone.
        const body = values.body.length > 0 ? values.body.map((v, i) => (i === 0 ? item.name : v)) : [];
        try {
          const res = await fetch("/api/whatsapp/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversation_id: item.conversationId,
              message_type: "template",
              template_name: template.name,
              template_language: template.language,
              template_message_params: {
                body,
                headerText: values.headerText,
                buttonParams: values.buttonParams,
              },
              template_params: body,
              content_text: renderTemplateBody(template.body_text, body),
            }),
          });
          if (res.ok) return { ok: true };
          const payload = await res.json().catch(() => ({}));
          return { ok: false, error: payload?.error || `HTTP ${res.status}` };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "error" };
        }
      },
    });
    setBulkProgress(null);
    setBulkPlan(null);
    const summary = t("bulkTemplateDone", { sent: outcome.sent, failed: outcome.failed.length });
    if (outcome.failed.length > 0 || outcome.stopped) toast.warning(outcome.stopped ? `${summary} ${t("bulkTemplateStopped")}` : summary);
    else toast.success(summary);
    exitSelecting();
  }, [bulkPlan, exitSelecting, t]);

  const handleBulkStage = useCallback(
    async (stageId: string | null) => {
      const ids = conversations.filter((c) => checkedIds.has(c.id)).map((c) => c.id);
      if (ids.length === 0) return;
      setBulkBusy(true);
      const supabase = createClient();
      const { error } = await supabase.from("conversations").update({ stage_id: stageId }).in("id", ids);
      if (error) {
        toast.error(t("bulkStageFailed"));
      } else {
        const touched = new Set(ids);
        onConversationsLoaded(conversations.map((c) => (touched.has(c.id) ? { ...c, stage_id: stageId } : c)));
        toast.success(t("bulkStageDone", { count: ids.length }));
        exitSelecting();
      }
      setBulkBusy(false);
    },
    [checkedIds, conversations, exitSelecting, onConversationsLoaded, t]
  );

  const handleBulkTag = useCallback(
    async (tagId: string, action: "add" | "remove") => {
      const tag = tagsById.get(tagId);
      const chosen = conversations.filter((c) => checkedIds.has(c.id) && c.contact);
      const contactIds = [...new Set(chosen.map((c) => c.contact!.id))];
      if (contactIds.length === 0 || !tag) return;
      setBulkBusy(true);
      try {
        for (let i = 0; i < contactIds.length; i += 500) {
          await bulkContactTag(contactIds.slice(i, i + 500), tagId, action);
        }
        // Mirror the change on the loaded conversations so the filter and
        // the contact panel agree without a refetch.
        const touched = new Set(contactIds);
        onConversationsLoaded(
          conversations.map((c) => {
            if (!c.contact || !touched.has(c.contact.id)) return c;
            const current = c.contact.tags ?? [];
            const without = current.filter((x) => x.id !== tagId);
            return {
              ...c,
              contact: {
                ...c.contact,
                tags: action === "add" ? [...without, tag] : without,
              },
            };
          })
        );
        toast.success(
          action === "add"
            ? t("bulkTagAdded", { tag: tag.name, count: contactIds.length })
            : t("bulkTagRemoved", { tag: tag.name, count: contactIds.length })
        );
        exitSelecting();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("bulkTagFailed"));
      }
      setBulkBusy(false);
    },
    [checkedIds, conversations, exitSelecting, onConversationsLoaded, t, tagsById]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {canEditTags && (
            <button
              type="button"
              onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
              aria-pressed={selecting}
              title={t("selectMode")}
              className={cn(
                "ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
                selecting ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <ListChecks className="h-3.5 w-3.5" />
              {t("selectMode")}
            </button>
          )}

          {stages.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedStageId ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">
                  {selectedStageId === "none"
                    ? t("noStage")
                    : selectedStageId
                      ? (stagesById.get(selectedStageId)?.name ?? t("stage"))
                      : t("stage")}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
                <DropdownMenuItem onClick={() => setSelectedStageId(null)} className="text-sm text-popover-foreground">
                  {t("allStages")}
                </DropdownMenuItem>
                {stages.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setSelectedStageId(s.id)}
                    className={cn("text-sm", selectedStageId === s.id ? "text-primary" : "text-popover-foreground")}
                  >
                    <span className="mr-2 size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onClick={() => setSelectedStageId("none")}
                  className={cn("text-sm", selectedStageId === "none" ? "text-primary" : "text-muted-foreground")}
                >
                  {t("noStage")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
          <span title={t("navHint")}>
            {activeIndex >= 0
              ? t("position", { current: activeIndex + 1, total: filtered.length })
              : t("total", { total: filtered.length })}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goTo(-1)}
              title={t("previous")}
              aria-label={t("previous")}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => goTo(1)}
              title={t("next")}
              aria-label={t("next")}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}

      {selecting && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <Checkbox
              checked={allFilteredChecked}
              indeterminate={!allFilteredChecked && someFilteredChecked}
              onCheckedChange={toggleAllFiltered}
              disabled={filtered.length === 0}
              aria-label={t("selectAllFiltered", { count: filtered.length })}
            />
            {checkedIds.size > 0
              ? t("selectedCount", { count: checkedIds.size })
              : t("selectAllFiltered", { count: filtered.length })}
          </label>
          {stages.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={bulkBusy || checkedIds.size === 0}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                <Layers className="h-3 w-3" />
                {t("setStage")}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
                {stages.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => handleBulkStage(s.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="mr-2 size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={() => handleBulkStage(null)} className="text-sm text-muted-foreground">
                  {t("noStage")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button
            type="button"
            disabled={bulkBusy || checkedIds.size === 0}
            onClick={() => setTemplatePickerOpen(true)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("sendTemplate")}
          </button>
          {([
            ["add", t("addTag")],
            ["remove", t("removeTag")],
          ] as const).map(([action, label]) => (
            <DropdownMenu key={action}>
              <DropdownMenuTrigger
                disabled={bulkBusy || checkedIds.size === 0 || tags.length === 0}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:opacity-50"
              >
                {label}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((tg) => (
                  <DropdownMenuItem
                    key={tg.id}
                    onClick={() => handleBulkTag(tg.id, action)}
                    className="text-sm text-popover-foreground"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tg.color }}
                    />
                    <span className="truncate">{tg.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
        </div>
      )}

      <TemplatePicker
        bulk
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onSelect={handleTemplatePicked}
      />

      <Dialog
        open={!!bulkPlan}
        onOpenChange={(open) => {
          if (!open && !bulkProgress) setBulkPlan(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <LayoutTemplate className="h-4 w-4 text-primary" />
              {t("bulkTemplateTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {bulkPlan &&
                t("bulkTemplateConfirm", {
                  name: bulkPlan.template.name,
                  count: bulkPlan.items.length,
                  minutes: Math.max(1, Math.ceil((bulkPlan.items.length * BULK_SEND_GAP_MS) / 60000)),
                })}
            </DialogDescription>
          </DialogHeader>
          {bulkProgress && (
            <div className="space-y-2">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((bulkProgress.done / Math.max(1, bulkProgress.total)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("bulkTemplateProgress", { done: bulkProgress.done, total: bulkProgress.total })}
              </p>
            </div>
          )}
          <DialogFooter className="gap-2">
            {bulkProgress ? (
              <Button variant="outline" onClick={() => (bulkStop.current = true)}>
                {t("bulkTemplateStop")}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setBulkPlan(null)}>
                  {t("bulkTemplateCancel")}
                </Button>
                <Button onClick={sendBulkTemplate}>
                  {bulkProgress ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutTemplate className="h-4 w-4" />}
                  {t("bulkTemplateSend")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div ref={listRef} className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                stage={conv.stage_id ? (stagesById.get(conv.stage_id) ?? null) : null}
                selecting={selecting}
                checked={checkedIds.has(conv.id)}
                onToggleChecked={toggleChecked}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  stage: { name: string; color: string } | null;
  selecting: boolean;
  checked: boolean;
  onToggleChecked: (id: string) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  stage,
  selecting,
  checked,
  onToggleChecked,
  t,
}: ConversationItemProps) {
  const locale = useLocale();
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    if (selecting) onToggleChecked(conversation.id);
    else onSelect(conversation);
  }, [selecting, onToggleChecked, onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: dateFnsLocale(locale),
      })
    : "";

  return (
    <div className="flex items-stretch" data-conv-id={conversation.id}>
    {selecting && (
      <div className="flex items-center pl-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleChecked(conversation.id)}
          aria-label={displayName}
        />
      </div>
    )}
    <button
      onClick={handleClick}
      className={cn(
        "flex min-w-0 flex-1 items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-4 border-primary bg-primary/15"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          {stage && (
            <span
              className="max-w-28 shrink-0 truncate rounded-full px-1.5 py-px text-[9px] font-medium"
              style={{ backgroundColor: `${stage.color}20`, color: stage.color }}
              title={stage.name}
            >
              {stage.name}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
    </div>
  );
}
