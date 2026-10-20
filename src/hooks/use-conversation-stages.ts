"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { sortStages } from "@/lib/inbox/stages";
import type { ConversationStage } from "@/types";

/**
 * The account's conversation stages, in order. Loaded once per mount; call
 * `reload` after the settings screen changes them.
 */
export function useConversationStages() {
  const [stages, setStages] = useState<ConversationStage[]>([]);

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.from("conversation_stages").select("*");
    if (data) setStages(sortStages(data as ConversationStage[]));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  const byId = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);

  return { stages, byId, reload };
}
