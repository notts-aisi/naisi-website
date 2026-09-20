import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { scanBucket, scanDayDocId } from "./scanBuckets";

/**
 * Counts one scan of a printed code.
 *
 * WHAT IS STORED, in full: the slug, the London day, a running count for that
 * day and a running count for each hour of it. One document per code per day,
 * so the collection grows by the number of codes a day and not by the number
 * of scans.
 *
 * WHAT IS NOT, on purpose: no IP address, no user agent, no referrer, no
 * account id, no timestamp finer than the hour and no row per scan. Nothing
 * here relates to a person, which is what lets the privacy policy stay as it
 * is: it says request logs are not used for analytics, and this does not read
 * them. `tests/scan-counting.test.mjs` holds the written fields to this list.
 *
 * ONLY A POST MAY CALL THIS. A GET is fetched by link previews, mail scanners
 * and prefetchers, so a GET that counted would count machines. The name is in
 * `MUTATION_HELPERS` in `tests/get-handlers-readonly.test.mjs`, which fails
 * any GET handler that calls it.
 *
 * Best-effort, like `recordSignupOutcome`: a counter must never be the reason
 * the page that fired it misbehaves. Returns whether the write landed, so the
 * route can say so and a deploy can be checked end to end without reading the
 * database. A single day's document has Firestore's soft limit of about one
 * write a second; past that an increment is dropped and the count runs low,
 * which is the right way for a marketing number to fail.
 */
export const SCAN_DAYS_COLLECTION = "linkScanDays";

export async function recordScan(slug: string, at: Date = new Date()): Promise<boolean> {
  const db = getAdminDb();
  if (!db) return false;
  try {
    const { date, hour } = scanBucket(at);
    const one = FieldValue.increment(1);
    await db
      .collection(SCAN_DAYS_COLLECTION)
      .doc(scanDayDocId(slug, date))
      .set({ slug, date, count: one, hours: { [hour]: one } }, { merge: true });
    return true;
  } catch (err) {
    console.error("[campaign] recordScan failed", err);
    return false;
  }
}
