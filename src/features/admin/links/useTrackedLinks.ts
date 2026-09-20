"use client";

import { useOneShotList } from "@/features/admin/adminList";
import type { TrackedLinkDoc } from "@/lib/firestore/trackedLinks";
import { listTrackedLinks } from "./trackedLinkData";

/**
 * The /admin/links list. One-shot with a Refresh button, matching every other
 * admin list: links change a few times a term, so an always-open listener
 * buys nothing.
 */
export function useTrackedLinks() {
  const { items, loading, refreshing, error, reload } = useOneShotList<TrackedLinkDoc>(
    () => listTrackedLinks(),
    "trackedLinks",
  );

  return { links: items, loading, refreshing, error, reload };
}
