import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeTrackedLink, type TrackedLinkDoc } from "@/lib/firestore/trackedLinks";
import type { TrackedLinkLookup } from "./resolveScan";

/**
 * The read behind a scan: one `trackedLinks/{slug}` document, on the Admin
 * SDK, with a deadline.
 *
 * READ-ONLY, and it has to stay that way. The short link's GET calls this,
 * and a GET is fetched by link previews and mail scanners as readily as by
 * people. Counting lives in `scanCounter.ts`, behind a POST, and nothing in
 * this file may import it.
 *
 * A DEADLINE, because the person on the other end is standing at a stall
 * holding a phone. A read that has not answered by then is treated as a
 * database that is not answering, and `resolveScan` falls back to the last
 * record this server saw and then to the printed list. Generous enough that a
 * cold first read on a fresh instance still makes it: a fallback taken too
 * eagerly would send a repointed code back to where it went on print day.
 */
export const TRACKED_LINKS_COLLECTION = "trackedLinks";

const READ_DEADLINE_MS = 2500;

// The last record each slug was successfully read as, for a read that fails
// later. Only records that EXIST are kept, so the map is bounded by the number
// of links the society has made and a flood of made-up slugs cannot grow it.
const lastGood = new Map<string, TrackedLinkDoc>();

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function lookupTrackedLink(slug: string): Promise<TrackedLinkLookup> {
  const db = getAdminDb();
  if (!db) return { state: "unavailable", lastKnown: lastGood.get(slug) ?? null };
  try {
    const snap = await deadline(
      db.collection(TRACKED_LINKS_COLLECTION).doc(slug).get(),
      READ_DEADLINE_MS,
    );
    if (!snap.exists) {
      lastGood.delete(slug);
      return { state: "missing" };
    }
    const link = normalizeTrackedLink(snap.id, snap.data() ?? {});
    lastGood.set(slug, link);
    return { state: "found", link };
  } catch (err) {
    console.error("[campaign] lookupTrackedLink failed", err);
    return { state: "unavailable", lastKnown: lastGood.get(slug) ?? null };
  }
}

/** Whether a slug names a link at all: a record, or a code that is on paper. */
export async function trackedLinkExists(slug: string): Promise<boolean> {
  const lookup = await lookupTrackedLink(slug);
  if (lookup.state === "found") return true;
  return lookup.state === "unavailable" && lookup.lastKnown !== null;
}
