"use client";

import { collection, getDocs, query, where } from "firebase/firestore";
import type { AttributedSignup, ScanDay } from "@/lib/campaign/linkStats";
import { scanBucket } from "@/lib/campaign/scanBuckets";
import { getClientDb } from "@/lib/firebase/client";

/**
 * The two reads behind the /admin/links dashboard. Client-direct under
 * admin-only rules, like the list beside it. Both owe an entry in
 * `scripts/rules-tests/tests/client-queries.registry.mjs`.
 *
 * NEITHER NEEDS A DECLARED INDEX, and that is a constraint on how they are
 * written, not luck. Each is a range on ONE field, which the automatic
 * single-field index serves. Add an `orderBy` on another field, or an equality
 * beside the range, and Firestore wants a composite index: the emulator does
 * not enforce indexes, so that would pass every local check and fail in
 * production with FAILED_PRECONDITION. Sort and filter in the browser instead;
 * `tests/firestore-indexes.test.mjs` reads these queries and says so if one
 * ever needs declaring.
 */

/** A date before anything was counted, so "all time" is the same query shape. */
export const ALL_TIME = "2000-01-01";

/** Every per-day counter on or after `fromDate` (`YYYY-MM-DD`, London). */
export async function listScanDays(fromDate: string): Promise<ScanDay[]> {
  const db = getClientDb();
  const snap = await getDocs(query(collection(db, "linkScanDays"), where("date", ">=", fromDate)));
  return snap.docs.map((d) => {
    const data = d.data();
    const hours: Record<string, number> = {};
    if (data.hours && typeof data.hours === "object") {
      for (const [hour, n] of Object.entries(data.hours as Record<string, unknown>)) {
        if (typeof n === "number") hours[hour] = n;
      }
    }
    return {
      slug: typeof data.slug === "string" ? data.slug : "",
      date: typeof data.date === "string" ? data.date : "",
      count: typeof data.count === "number" ? data.count : 0,
      hours,
    };
  });
}

/**
 * Every subscription a short link produced: the rows whose `source` starts
 * `qr:`. A prefix match is a range from `qr:` up to, and not including, the
 * next string after every `qr:...`, which is `qr;` (a semicolon follows a
 * colon).
 *
 * Only what the dashboard counts is kept. The address is needed to count
 * people and not rows, and goes no further than `buildLinkStats`.
 */
export async function listAttributedSignups(): Promise<AttributedSignup[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(collection(db, "subscriptions"), where("source", ">=", "qr:"), where("source", "<", "qr;")),
  );
  return snap.docs.map((d) => {
    const data = d.data();
    const created = data.createdAt;
    const at =
      created && typeof created.toDate === "function" ? (created.toDate() as Date) : null;
    return {
      email: typeof data.email === "string" ? data.email : "",
      source: typeof data.source === "string" ? data.source : "",
      confirmed: data.confirmed === true,
      createdOn: at ? scanBucket(at).date : null,
    };
  });
}
