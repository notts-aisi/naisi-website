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

/** Create the per-account registration row when a brand-new account is registered. */
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
      emailVerified: false,
      passwordSet: false,
      status: deriveRegistrationStatus(false, false),
      createdAt: now,
      updatedAt: now,
      lastSentAt: now,
      sendCount: 1,
    });
  } catch (err) {
    console.error("[registrations] recordRegistrationCreated failed", err);
  }
}

/** Bump the resend counters when an existing PENDING account re-sends its link. */
export async function recordRegistrationResend(uid: string): Promise<void> {
  const db = getAdminDb();
  if (!db) return;
  try {
    const now = Timestamp.now();
    await db.collection(REGISTRATIONS_COLLECTION).doc(uid).set(
      {
        lastSentAt: now,
        updatedAt: now,
        sendCount: FieldValue.increment(1),
      },
      { merge: true },
    );
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
    const passwordSet = Boolean(snap.data()?.passwordSet);
    await ref.update({
      emailVerified: true,
      status: deriveRegistrationStatus(true, passwordSet),
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
    await db.collection(REGISTRATIONS_COLLECTION).doc(uid).update({
      passwordSet: true,
      emailVerified: true,
      status: deriveRegistrationStatus(true, true),
      updatedAt: Timestamp.now(),
    });
  } catch (err) {
    // NOT_FOUND here just means the account predates the tracker — benign.
    console.error("[registrations] markRegistrationPasswordSet skipped/failed", err);
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
