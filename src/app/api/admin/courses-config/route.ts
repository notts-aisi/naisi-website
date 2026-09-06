import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  COURSE_CONFIG_PATH,
  DEFAULT_COURSES_CONFIG,
  readCoursesConfig,
} from "@/lib/firestore/config";

/**
 * Admin-only read and write of the two `config/courses` knobs a human ever
 * has cause to change: the anonymous drop-out feedback form, and how long a
 * register may go unmarked before the follow-up job chases the facilitator.
 *
 * ── WHY A ROUTE AT ALL ──────────────────────────────────────────────────────
 * `config` has no client read rule and no client write rule, in either
 * direction, and it stays that way: it sits beside `config/taskEmails` in a
 * collection whose whole posture is Admin SDK only. So the panel cannot read
 * or write the doc itself, and this route is the only door.
 *
 * ── WHY ONLY TWO FIELDS ─────────────────────────────────────────────────────
 * The other three (`nextSessionMaxDays`, `unmarkedScanBudgetMs`,
 * `maxFollowUpTasksPerTick`) are scheduler cost dials. They have sensible
 * defaults, changing one wrongly degrades a background job in ways nobody
 * would connect to a form they filled in, and the console is the right place
 * for that. Exposing every field because they happen to share a document
 * would make the panel a way to break the tick.
 *
 * ── MERGE, NEVER REPLACE ────────────────────────────────────────────────────
 * The write is `set(..., { merge: true })` over the two named keys. A full
 * overwrite from a panel that only knows two fields would silently reset the
 * three it does not, which is exactly the class of bug the narrow surface
 * above is meant to avoid.
 *
 * This route ADMINISTERS configuration and lives under /api/admin, so nothing
 * here may be gated on the maintenance notice (tests/no-admin-gating.test.mjs).
 */

/** Generous ceiling: a fortnight. Past that the job would chase a register
    from a session nobody remembers, which is noise rather than a nudge. */
const MAX_GRACE_HOURS = 336;

export async function GET() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  const config = await readCoursesConfig(db);
  return NextResponse.json({
    dropOutFeedbackUrl: config.dropOutFeedbackUrl,
    weeklyFeedbackUrl: config.weeklyFeedbackUrl,
    unmarkedRegisterGraceHours: config.unmarkedRegisterGraceHours,
    defaults: {
      dropOutFeedbackUrl: DEFAULT_COURSES_CONFIG.dropOutFeedbackUrl,
      weeklyFeedbackUrl: DEFAULT_COURSES_CONFIG.weeklyFeedbackUrl,
      unmarkedRegisterGraceHours:
        DEFAULT_COURSES_CONFIG.unmarkedRegisterGraceHours,
    },
  });
}

export async function POST(req: Request) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  /**
   * The two link fields validate identically, so they share one check rather
   * than two copies that could drift. Named per field so an admin reads about
   * the box they typed in.
   */
  const readUrlField = (
    key: "dropOutFeedbackUrl" | "weeklyFeedbackUrl",
    what: string,
  ): string | NextResponse => {
    const raw = body[key];
    if (typeof raw !== "string") {
      return NextResponse.json({ error: `${what} must be text.` }, { status: 400 });
    }
    const url = raw.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        {
          error: `${what} needs to start with http:// or https://. Leave it empty to show no link at all.`,
        },
        { status: 400 },
      );
    }
    if (url.length > 500) {
      return NextResponse.json({ error: "That link is too long to store." }, { status: 400 });
    }
    return url;
  };

  if ("weeklyFeedbackUrl" in body) {
    // Rides the weekly reminder the attendance push sends, so an unset value
    // is not a broken state: the renderer drops the sentence whole.
    const url = readUrlField("weeklyFeedbackUrl", "The weekly feedback link");
    if (typeof url !== "string") return url;
    update.weeklyFeedbackUrl = url;
  }

  if ("dropOutFeedbackUrl" in body) {
    // The scheme is checked HERE as well as in `readCoursesConfig`, and the
    // duplication is deliberate: the reader's check is what makes rendering
    // the value in an href safe whatever is already stored, and this one is
    // what tells an admin they typed something wrong instead of silently
    // storing a value that will never appear.
    const url = readUrlField("dropOutFeedbackUrl", "The drop-out feedback link");
    if (typeof url !== "string") return url;
    update.dropOutFeedbackUrl = url;
  }

  if ("unmarkedRegisterGraceHours" in body) {
    const hours = body.unmarkedRegisterGraceHours;
    if (
      typeof hours !== "number" ||
      !Number.isFinite(hours) ||
      hours <= 0 ||
      hours > MAX_GRACE_HOURS
    ) {
      return NextResponse.json(
        {
          error: `The grace period must be a number of hours between 1 and ${MAX_GRACE_HOURS}.`,
        },
        { status: 400 },
      );
    }
    update.unmarkedRegisterGraceHours = hours;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  update.updatedAt = FieldValue.serverTimestamp();
  update.updatedByUid = actor.uid;
  update.updatedByName = actor.displayName ?? "";

  await db
    .collection(COURSE_CONFIG_PATH.collection)
    .doc(COURSE_CONFIG_PATH.doc)
    .set(update, { merge: true });

  const config = await readCoursesConfig(db);
  return NextResponse.json({
    ok: true,
    dropOutFeedbackUrl: config.dropOutFeedbackUrl,
    weeklyFeedbackUrl: config.weeklyFeedbackUrl,
    unmarkedRegisterGraceHours: config.unmarkedRegisterGraceHours,
  });
}
