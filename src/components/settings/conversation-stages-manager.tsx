'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Layers, Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  STAGE_COLORS,
  STAGE_NAME_MAX,
  cleanStageName,
  moveStage,
  nextStagePosition,
  sortStages,
  stageNameTaken,
} from '@/lib/inbox/stages';
import type { ConversationStage } from '@/types';

function ColorSwatches({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {STAGE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-pressed={value === color}
          aria-label={color}
          className={cn(
            'size-4 rounded-full border border-transparent transition-transform',
            value === color && 'scale-125 ring-2 ring-foreground/50 ring-offset-1 ring-offset-background',
          )}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

/**
 * Conversation stages — the account's own labels for where a chat stands in
 * its process (e.g. "Asesor Comercial Asignado"). Independent from the
 * Open / Pending / Closed status, which the automation depends on. Admin
 * and owner only (the database enforces it too).
 */
export function ConversationStagesManager() {
  const t = useTranslations('Settings.stages');
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [stages, setStages] = useState<ConversationStage[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(STAGE_COLORS[6]);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<ConversationStage | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stagesRes, usedRes] = await Promise.all([
        supabase.from('conversation_stages').select('*'),
        supabase.from('conversations').select('stage_id').not('stage_id', 'is', null),
      ]);
      if (stagesRes.error) throw stagesRes.error;
      const sorted = sortStages((stagesRes.data ?? []) as ConversationStage[]);
      setStages(sorted);
      setNames(Object.fromEntries(sorted.map((s) => [s.id, s.name])));
      const counts: Record<string, number> = {};
      for (const row of (usedRes.data ?? []) as { stage_id: string }[]) {
        counts[row.stage_id] = (counts[row.stage_id] ?? 0) + 1;
      }
      setUsage(counts);
    } catch (err) {
      console.error('Failed to load stages:', err);
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    if (authLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [authLoading, load]);

  async function handleAdd() {
    const name = cleanStageName(newName);
    if (!name) {
      toast.error(t('nameInvalid', { max: STAGE_NAME_MAX }));
      return;
    }
    if (stageNameTaken(stages, name)) {
      toast.error(t('nameTaken'));
      return;
    }
    if (!accountId) return;
    setSaving(true);
    const { error } = await supabase.from('conversation_stages').insert({
      account_id: accountId,
      name,
      color: newColor,
      position: nextStagePosition(stages),
    });
    setSaving(false);
    if (error) {
      console.error('Create stage failed:', error);
      toast.error(t('saveError'));
      return;
    }
    setNewName('');
    toast.success(t('added'));
    await load();
  }

  async function handleRename(stage: ConversationStage) {
    const name = cleanStageName(names[stage.id] ?? '');
    if (!name) {
      toast.error(t('nameInvalid', { max: STAGE_NAME_MAX }));
      setNames((prev) => ({ ...prev, [stage.id]: stage.name }));
      return;
    }
    if (name === stage.name) return;
    if (stageNameTaken(stages, name, stage.id)) {
      toast.error(t('nameTaken'));
      setNames((prev) => ({ ...prev, [stage.id]: stage.name }));
      return;
    }
    const { error } = await supabase.from('conversation_stages').update({ name }).eq('id', stage.id);
    if (error) {
      toast.error(t('saveError'));
      return;
    }
    setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, name } : s)));
    toast.success(t('renamed'));
  }

  async function handleColor(stage: ConversationStage, color: string) {
    if (color === stage.color) return;
    const { error } = await supabase.from('conversation_stages').update({ color }).eq('id', stage.id);
    if (error) {
      toast.error(t('saveError'));
      return;
    }
    setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, color } : s)));
  }

  async function handleMove(stage: ConversationStage, direction: 'up' | 'down') {
    const moves = moveStage(stages, stage.id, direction);
    if (!moves) return;
    const results = await Promise.all(
      moves.map((m) => supabase.from('conversation_stages').update({ position: m.position }).eq('id', m.id)),
    );
    if (results.some((r) => r.error)) {
      toast.error(t('saveError'));
    }
    await load();
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    const { error } = await supabase.from('conversation_stages').delete().eq('id', toDelete.id);
    setDeleting(false);
    if (error) {
      toast.error(t('saveError'));
      return;
    }
    toast.success(t('deleted'));
    setToDelete(null);
    await load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Layers className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {stages.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="space-y-2">
                {stages.map((stage, index) => (
                  <li
                    key={stage.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2"
                  >
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color }}
                      aria-hidden
                    />
                    <Input
                      value={names[stage.id] ?? stage.name}
                      maxLength={STAGE_NAME_MAX}
                      onChange={(e) => setNames((prev) => ({ ...prev, [stage.id]: e.target.value }))}
                      onBlur={() => handleRename(stage)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      aria-label={t('nameLabel')}
                      className="h-8 min-w-40 flex-1"
                    />
                    <ColorSwatches
                      value={stage.color}
                      onChange={(c) => handleColor(stage, c)}
                      label={t('colorLabel')}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('usedBy', { count: usage[stage.id] ?? 0 })}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === 0}
                        onClick={() => handleMove(stage, 'up')}
                        aria-label={t('moveUp')}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === stages.length - 1}
                        onClick={() => handleMove(stage, 'down')}
                        aria-label={t('moveDown')}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setToDelete(stage)}
                        aria-label={t('deleteAria', { name: stage.name })}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Input
                value={newName}
                maxLength={STAGE_NAME_MAX}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                }}
                placeholder={t('newPlaceholder')}
                aria-label={t('newPlaceholder')}
                className="h-8 min-w-40 flex-1"
              />
              <ColorSwatches value={newColor} onChange={setNewColor} label={t('colorLabel')} />
              <Button type="button" size="sm" onClick={handleAdd} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('add')}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: toDelete?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('deleteDescription', { count: toDelete ? (usage[toDelete.id] ?? 0) : 0 })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setToDelete(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
