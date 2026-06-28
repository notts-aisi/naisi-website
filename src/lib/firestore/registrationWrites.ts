import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  REGISTRATIONS_COLLECTION,
  SIGNUP_METRICS_COLLECTION,
  SIGNUP_OUTCOME_FIELD,
  deriveRegistrationStatus,
  metricsDateKey,
  type RegistrationAudience,
  type SignupOutcome,
} from "./registrations";

/**
 * Admin-SDK write helpers for the signup tracker. Every one of these is a
 * BEST-EFFORT side-effect: it swallows its own errors (logs and returns) so a
 * tracker write can never change the enumeration-safe register response or break
 * the verify / set-password flows. The account lifecycle is the source of truth;
 * the tracker just mirrors it for the admin console.
 *
 * Each helper fetches its own db (cached) so call sites stay one-liners.
 *
 * See [registrations.ts] for the data model and why there are two stores.
 */

/** Create the per-account registration row when a brand-new EMAIL account is registered. */
export async function recordRegistrationCreated(args: {
  uid: string;
  email: string;
  audience: RegistrationAudience;
}): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const now = Timestamp.now();
    // Plain set (not merge): the uid is freshly minted by createUser, so the doc
    // can't pre-exist. createdAt is written exactly once, here.
    await db.collection(REGISTRATIONS_COLLECTION).doc(args.uid).set({
      uid: args.uid,
      email: args.email,
      audience: args.audience,
      method: "email",
      emailVerified: false,
      passwordSet: false,
      profileComplete: false,
      status: deriveRegistrationStatus("email", { emailVerified: false, passwordSet: false }),
      createdAt: now,
      updatedAt: now,
      lastSentAt: now,
      sendCount: 1,
    });
  } catch (err) {
    console.error("[registrations] recordRegistrationCreated failed", err);
  }
}

/**
 * Mirror a brand-new GOOGLE sign-in into the tracker so Google orphans
 * (authenticated, but never wrote a profile) are visible to admins — the analogue
 * of recordRegistrationCreated for the email flow. Google verifies the email up
 * front and there is no password step, so the row starts emailVerified:true,
 * status "pending-profile" (an orphan until a profile doc is written).
 *
 * Unlike the email creator this must be IDEMPOTENT: the session route fires on
 * every sign-in, and a returning Google orphan re-mints before finishing. We
 * guard on existence so createdAt is written exactly once and an existing row
 * (incl. a pre-existing EMAIL row for a uid that later linked Google) is never
 * clobbered. Audience is unknown at sign-in (no form chosen yet) → defaults to
 * "member"; markRegistrationProfileComplete corrects it for collaborators.
 */
export async function recordGoogleRegistrationCreated(args: {
  uid: string;
  email: string;
  audience?: RegistrationAudience;
}): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const ref = db.collection(REGISTRATIONS_COLLECTION).doc(args.uid);
    const snap = await ref.get();
    if (snap.exists) return; // createdAt written once; don't clobber an existing row
    const now = Timestamp.now();
    await ref.set({
      uid: args.uid,
      email: args.email,
      audience: args.audience ?? "member",
      method: "google",
      emailVerified: true,
      passwordSet: false,
      profileComplete: false,
      status: deriveRegistrationStatus("google", { profileComplete: false }),
      createdAt: now,
      updatedAt: now,
      lastSentAt: null,
      sendCount: 0,
    });
  } catch (err) {
    console.error("[registrations] recordGoogleRegistrationCreated failed", err);
  }
}

/**
 * Bump the resend counters when an existing PENDING account re-sends its link.
 * Only ever UPDATES an existing row — never creates one. A merge-set here would
 * create a partial doc with no `createdAt`, which the createdAt-ordered list
 * query silently drops while count() still counts it (a count/list mismatch).
 * Accounts that predate this collection therefore stay untracked on re-send,
 * consistent with the forward-looking, no-backfill design.
 */
export async function recordRegistrationResend(uid: string): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const ref = db.collection(REGISTRATIONS_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return; // never create a row here (would lack createdAt)
    const now = Timestamp.now();
    await ref.update({
      lastSentAt: now,
      updatedAt: now,
      sendCount: FieldValue.increment(1),
    });
  } catch (err) {
    console.error("[registrations] recordRegistrationResend failed", err);
  }
}

/**
 * Flip emailVerified on the registration row when the magic link is confirmed.
 * Only updates an EXISTING row (never creates a partial one — a doc missing
 * createdAt would be dropped by the createdAt-ordered list query, per the
 * no-orderBy-on-sparse-fields rule). passwordSet is read so the denormalised
 * status stays correct even if the link is re-clicked after the password is set.
 */
export async function markRegistrationEmailVerified(uid: string): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const ref = db.collection(REGISTRATIONS_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return; // account predates the tracker — nothing to mirror
    const data = snap.data() ?? {};
    const passwordSet = Boolean(data.passwordSet);
    // Email-only path (Google has no magic link), but read method defensively.
    const method = data.method === "google" ? "google" : "email";
    await ref.update({
      emailVerified: true,
      status: deriveRegistrationStatus(method, {
        emailVerified: true,
        passwordSet,
        profileComplete: Boolean(data.profileComplete),
      }),
      updatedAt: Timestamp.now(),
    });
  } catch (err) {
    console.error("[registrations] markRegistrationEmailVerified failed", err);
  }
}

/**
 * Mark the registration completed once the user sets their real password. By
 * this point they've clicked the link, so emailVerified is also true. Only
 * touches an existing row (update throws on a missing doc → caught → skipped for
 * pre-tracker accounts).
 */
export async function markRegistrationPasswordSet(uid: string): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    // Only the email flow has a password step, so "email" is correct here (and
    // safe even in the impossible Google case — passwordSet:true ⇒ completed).
    await db.collection(REGISTRATIONS_COLLECTION).doc(uid).update({
      passwordSet: true,
      emailVerified: true,
      status: deriveRegistrationStatus("email", { emailVerified: true, passwordSet: true }),
      updatedAt: Timestamp.now(),
    });
  } catch (err) {
    // NOT_FOUND here just means the account predates the tracker — benign.
    console.error("[registrations] markRegistrationPasswordSet skipped/failed", err);
  }
}

/**
 * Mark the registration row "profile complete" once a member/collaborator profile
 * doc has been written. For a GOOGLE account this is what flips it from
 * "pending-profile" (orphan) to "completed"; for an EMAIL account the status is
 * already driven by passwordSet, so this just records the extra `profileComplete`
 * signal (and, when given, corrects a Google orphan's default "member" audience to
 * "collaborator"). Only ever touches an existing row (caught NOT_FOUND = pre-tracker
 * or unrecorded account). Best-effort — the profile doc is the source of truth.
 */
export async function markRegistrationProfileComplete(
  uid: string,
  opts?: { audience?: RegistrationAudience },
): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const ref = db.collection(REGISTRATIONS_COLLECTION).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return; // no tracker row to update (e.g. pre-tracker account)
    const data = snap.data() ?? {};
    const method = data.method === "google" ? "google" : "email";
    const update: Record<string, unknown> = {
      profileComplete: true,
      status: deriveRegistrationStatus(method, {
        emailVerified: Boolean(data.emailVerified),
        passwordSet: Boolean(data.passwordSet),
        profileComplete: true,
      }),
      updatedAt: Timestamp.now(),
    };
    if (opts?.audience) update.audience = opts.audience;
    await ref.update(update);
  } catch (err) {
    console.error("[registrations] markRegistrationProfileComplete skipped/failed", err);
  }
}

/**
 * Increment the daily signup-outcome counters. One doc per UTC day, so this is
 * bounded regardless of attempt volume. Best-effort.
 *
 * NB: a single daily doc has Firestore's ~1 write/sec soft limit. Under an
 * extreme sustained flood some increments may be dropped (the counter just
 * undercounts — no functional harm). If that ever matters, shard the key
 * (`${date}_${0..N}`) and sum on read; not worth it at this scale.
 */
export async function recordSignupOutcome(outcome: SignupOutcome): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const key = metricsDateKey(new Date());
    const inc = FieldValue.increment(1);
    await db.collection(SIGNUP_METRICS_COLLECTION).doc(key).set(
      {
        date: key,
        attempts: inc,
        [SIGNUP_OUTCOME_FIELD[outcome]]: inc,
        updatedAt: Timestamp.now(),
      },
      { merge: true },
    );
  } catch (err) {
    console.error("[registrations] recordSignupOutcome failed", err);
  }
}
