import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  REGISTRATIONS_COLLECTION,
  SIGNUP_METRICS_COLLECTION,
  recentMetricsDateKeys,
  type RegistrationFlag,
  type RegistrationSummary,
} from "@/lib/firestore/registrations";

/**
 * Flagger summary for the admin registrations tab: status counts, account-
 * creation velocity (burst signal), and the reCAPTCHA fail-rate, plus any flags
 * the thresholds trip. Admin-only.
 *
 * Cost: counts use Firestore aggregation (`count()`, ≈1 read / 1000 docs — NOT
 * snap.size full scans), and the reCAPTCHA rate reads a bounded handful of daily
 * counter docs. So the whole summary is a few reads regardless of how many
 * orphans have accumulated.
 */

// Tunable thresholds. Sized for a small society's signup volume — revisit if the
// org grows. Velocity counts NEW ACCOUNTS created in the trailing hour.
const BURST_AMBER = 15;
const BURST_RED = 40;
// reCAPTCHA fail-rate over the trailing window, only once the sample is big
// enough to be meaningful.
const METRICS_WINDOW_DAYS = 7;
const RECAPTCHA_MIN_SAMPLE = 10;
const RECAPTCHA_AMBER = 0.3;
const RECAPTCHA_RED = 0.6;
// Benign orphans accumulate by design; only surface them once there's a real
// backlog worth a cleanup sweep.
const ORPHAN_AMBER = 100;

function aggCount(snap: { data: () => { count: number } }): number {
  return snap.data().count;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export async function GET() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const coll = db.collection(REGISTRATIONS_COLLECTION);
  const now = Date.now();
  const since1h = Timestamp.fromMillis(now - 60 * 60 * 1000);
  const since24h = Timestamp.fromMillis(now - 24 * 60 * 60 * 1000);

  // Status counts + creation velocity, all via aggregation in parallel.
  const [
    pendingSnap,
    verifiedNoPwSnap,
    pendingProfileSnap,
    completedSnap,
    last1hSnap,
    last24hSnap,
  ] = await Promise.all([
    coll.where("status", "==", "pending-verify").count().get(),
    coll.where("status", "==", "verified-no-password").count().get(),
    coll.where("status", "==", "pending-profile").count().get(),
    coll.where("status", "==", "completed").count().get(),
    coll.where("createdAt", ">=", since1h).count().get(),
    coll.where("createdAt", ">=", since24h).count().get(),
  ]);

  const pendingVerify = aggCount(pendingSnap);
  const verifiedNoPassword = aggCount(verifiedNoPwSnap);
  const pendingProfile = aggCount(pendingProfileSnap);
  const completed = aggCount(completedSnap);
  // Orphans = anything that isn't a finished account, across both methods.
  const orphans = pendingVerify + verifiedNoPassword + pendingProfile;
  const last1h = aggCount(last1hSnap);
  const last24h = aggCount(last24hSnap);

  // reCAPTCHA fail-rate from the bounded daily counter docs.
  const keys = recentMetricsDateKeys(new Date(), METRICS_WINDOW_DAYS);
  const metricSnaps = await db.getAll(
    ...keys.map((k) => db.collection(SIGNUP_METRICS_COLLECTION).doc(k)),
  );
  let recaptchaFailed = 0;
  let reachedGate = 0; // attempts that actually reached the reCAPTCHA check
  for (const snap of metricSnaps) {
    if (!snap.exists) continue;
    const d = snap.data() ?? {};
    const failed = num(d.recaptchaFailed);
    // Everything that passed the gate (created + both existing branches) + the
    // ones that failed it = the denominator. invalid-email is excluded (rejected
    // before the gate), so it doesn't dilute the rate.
    reachedGate +=
      num(d.created) + num(d.existingVerified) + num(d.existingUnverified) + failed;
    recaptchaFailed += failed;
  }
  const failRate = reachedGate > 0 ? recaptchaFailed / reachedGate : 0;

  // Trip the flags.
  const flags: RegistrationFlag[] = [];
  if (last1h >= BURST_RED) {
    flags.push({
      level: "red",
      kind: "burst",
      message: `${last1h} new accounts created in the last hour.`,
    });
  } else if (last1h >= BURST_AMBER) {
    flags.push({
      level: "amber",
      kind: "burst",
      message: `${last1h} new accounts created in the last hour.`,
    });
  }
  if (reachedGate >= RECAPTCHA_MIN_SAMPLE) {
    if (failRate >= RECAPTCHA_RED) {
      flags.push({
        level: "red",
        kind: "recaptcha",
        message: `${pct(failRate)} of signup attempts failed reCAPTCHA over the last ${METRICS_WINDOW_DAYS} days.`,
      });
    } else if (failRate >= RECAPTCHA_AMBER) {
      flags.push({
        level: "amber",
        kind: "recaptcha",
        message: `${pct(failRate)} of signup attempts failed reCAPTCHA over the last ${METRICS_WINDOW_DAYS} days.`,
      });
    }
  }
  if (orphans >= ORPHAN_AMBER) {
    flags.push({
      level: "amber",
      kind: "orphans",
      message: `${orphans} benign orphan registrations are waiting for cleanup.`,
    });
  }

  const summary: RegistrationSummary = {
    counts: {
      total: pendingVerify + verifiedNoPassword + pendingProfile + completed,
      pendingVerify,
      verifiedNoPassword,
      pendingProfile,
      completed,
      orphans,
    },
    velocity: { last1h, last24h },
    recaptcha: {
      windowDays: METRICS_WINDOW_DAYS,
      attempts: reachedGate,
      failed: recaptchaFailed,
      failRate,
    },
    flags,
  };

  return NextResponse.json(summary);
}
