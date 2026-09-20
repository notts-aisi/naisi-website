"use client";

import { useOneShotList } from "@/features/admin/adminList";
import type { SourceSheetDoc } from "@/lib/firestore/sourceSheets";
import { listSourceSheets } from "./sourceSheetData";

/**
 * The /admin/sources list. One-shot with a Refresh button, matching every
 * other admin list: these change a few times a term, so an always-open
 * listener buys nothing.
 */
export function useSourceSheets() {
  const { items, loading, refreshing, error, reload } = useOneShotList<SourceSheetDoc>(
    () => listSourceSheets(),
    "sourceSheets",
  );

  return { sheets: items, loading, refreshing, error, reload };
}
