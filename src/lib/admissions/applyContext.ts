import "server-only";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import { verifyRecaptcha } from "@/lib/recaptcha/server";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import {
  DEFAULT_PAUSED_MESSAGE,
  DEFAULT_SITE_NOTICE,
  SITE_NOTICE_PATH,
  isSurfacePaused,
  normaliseSiteNotice,
} from "@/lib/siteNotice";
import {
  admissionApplicationId,
  admissionApplicationPrivateId,
  normalizeAdmissionApplication,
  type AdmissionApplicationDoc,
} from "@/lib/firestore/admissionApplications";
import { normalizeAdmissionApplicationPrivate } from "@/lib/firestore/admissionApplicationPrivate";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
  type AdmissionRoundDoc,
  type AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
} from "./roundRoutes";
import { roundWindowState } from "./window";
import { APPLY_RATE_LIMITS, type RecaptchaAction } from "./applyRoutes";

/**
 * The datastore-touching half of the apply tree: the request prologue every
 * handler runs, and the two collection names the handlers address.
 *
 * Split from `applyRoutes.ts` on purpose. That module is pure (validation,
 * projections, the release filter) so the test harness can transpile and
 * import it without a Firebase Admin SDK in the graph; this one imports the
 * Admin SDK and is pinned by source instead. Keeping the pure half importable
 * is what lets the release boundary be tested by executing it rather than by
 * reading it.
 */

export const APPLICATIONS_COLLECTION = "admissionApplications";
export const APPLICATION_PRIVATE_COLLECTION = "admissionApplicationPrivate";

export type Db = NonNullable<ReturnType<typeof getAdminDb>>;

/** An error carrying the sentence and the status a handler should answer with. */
export class ApplyError extends Error {
  status: number;
  extra: Record<string, unknown>;

  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApplyError";
    this.status = status;
    this.extra = extra;
  }

  toResponse(): NextResponse {
    return NextResponse.json({ error: this.message, ...this.extra }, { status: this.status });
  }
}

export function tooManyAttempts(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many attempts. Please wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export type Caller = { user: SessionUser; db: Db };

/**
 * Session plus the Admin SDK, or the response to return instead.
 *
 * `pending` accounts are ALLOWED, deliberately and load-bearingly: the whole
 * funnel is "register, then apply", and the account made at the fair on Monday
 * is still pending on Sunday when applications close. A `rejected` account is
 * the only signed-in caller turned away.
 */
export async function requireApplicant(): Promise<Caller | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (user.role === "rejected") {
    return NextResponse.json(
      { error: "This account cannot apply." },
      { status: 403 },
    );
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }
  return { user, db };
}

export type ThrottleKind = "create" | "save";

/**
 * The abuse throttles, run BEFORE any datastore read.
 *
 * That ordering is the entire point: the reason to throttle these routes is to
 * cap cost, so a limiter sitting after the reads it protects has already paid
 * for the request it is about to refuse. `tests/admissions-apply-flow.test.mjs`
 * pins the ordering against the route sources.
 *
 * TWO FUNCTIONS, not one with a nullable uid, because each call COUNTS A HIT.
 * A single helper called twice per request (once before the session lookup for
 * the IP axis, once after it for the account axis) would count two hits
 * against the IP bucket for every one request, quietly halving a budget
 * deliberately set generous for a campus sharing one NAT address.
 */
export function throttleIp(req: Request, kind: ThrottleKind): NextResponse | null {
  const L = APPLY_RATE_LIMITS;
  const max = kind === "create" ? L.createIpMax : L.saveIpMax;
  const hit = rateLimit(`admissions:apply:${kind}:ip:${clientIp(req)}`, max, L.windowMs);
  return hit.ok ? null : tooManyAttempts(hit.retryAfterSeconds);
}

export function throttleUid(uid: string, kind: ThrottleKind): NextResponse | null {
  const L = APPLY_RATE_LIMITS;
  const max = kind === "create" ? L.createUidMax : L.saveUidMax;
  const hit = rateLimit(`admissions:apply:${kind}:uid:${uid}`, max, L.windowMs);
  return hit.ok ? null : tooManyAttempts(hit.retryAfterSeconds);
}

/**
 * Verify the reCAPTCHA token minted for THIS action.
 *
 * The token is minted at the moment the button is pressed, never at page load:
 * a Google token goes stale in about two minutes, and somebody writing a
 * five-hundred-word answer will be past that long before they submit. The
 * `action` argument is not sent to Google (the free `siteverify` on a v2
 * Invisible key has nothing to compare it against); it exists so the caller
 * has to name which action it is verifying and so the failure log says which.
 *
 * FAILS CLOSED IN PRODUCTION when `RECAPTCHA_SECRET` is absent, which is
 * `verifyRecaptcha`'s documented behaviour and is why the secret must be
 * provisioned on every backend that runs in production mode, dev included.
 */
export async function requireRecaptcha(
  body: Record<string, unknown>,
  action: RecaptchaAction,
): Promise<NextResponse | null> {
  const token = typeof body.recaptchaToken === "string" ? body.recaptchaToken : undefined;
  if (await verifyRecaptcha(token)) return null;
  console.warn(`[admissions apply] recaptcha refused action=${action}`);
  return NextResponse.json(
    {
      error:
        "We could not confirm you are a person. Reload the page and try again; if it keeps happening, email us and we will take the application by hand.",
    },
    { status: 403 },
  );
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The maintenance pause, read with the shared helper so a paused surface reads
 * identically everywhere. FAIL-OPEN on an unreadable doc: refusing an
 * application because the outage banner could not be read would be an outage
 * caused by the outage banner.
 *
 * The stored field is `pauseCourseApplications`, reused verbatim by the round
 * routes: renaming it would migrate a live config doc for cosmetics. Only its
 * label changed, to "Admissions".
 */
export async function applicationsPaused(db: Db): Promise<string | null> {
  let notice = DEFAULT_SITE_NOTICE;
  try {
    const snap = await db
      .collection(SITE_NOTICE_PATH.collection)
      .doc(SITE_NOTICE_PATH.doc)
      .get();
    notice = normaliseSiteNotice(snap.exists ? snap.data() : null, new Date());
  } catch {
    return null;
  }
  if (!isSurfacePaused(notice, "courseApplications")) return null;
  return notice.bannerMessage || DEFAULT_PAUSED_MESSAGE;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function roundRef(db: Db, roundId: string) {
  return db.collection(ROUNDS_COLLECTION).doc(roundId);
}

export function applicationRef(db: Db, roundId: string, uid: string) {
  return db.collection(APPLICATIONS_COLLECTION).doc(admissionApplicationId(roundId, uid));
}

export function privateRef(db: Db, roundId: string, uid: string) {
  return db
    .collection(APPLICATION_PRIVATE_COLLECTION)
    .doc(admissionApplicationPrivateId(roundId, uid));
}

/**
 * The round, or an `ApplyError` a handler can throw.
 *
 * A DRAFT or ARCHIVED round is "not found", with the same sentence as a round
 * that never existed. Which of the two it is says something about NAISI's
 * plans that an applicant has no business reading off a status code.
 */
export async function loadRound(db: Db, roundId: string): Promise<AdmissionRoundDoc> {
  const snap = await roundRef(db, roundId).get();
  if (!snap.exists) throw new ApplyError("Round not found.", 404);
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});
  if (round.archived || round.status === "draft") {
    throw new ApplyError("Round not found.", 404);
  }
  return round;
}

export async function loadStages(db: Db, roundId: string): Promise<AdmissionStageDoc[]> {
  const snap = await roundRef(db, roundId).collection(STAGES_SUBCOLLECTION).get();
  return snap.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order);
}

/**
 * The window, translated into the applicant's sentence. ONE predicate, shared
 * with the page that renders the form, so discovery and submit cannot
 * disagree about whether the window is open (the lesson `window.ts` records).
 */
export function windowRefusal(round: AdmissionRoundDoc, now: Date): string | null {
  const { state } = roundWindowState(round, now);
  if (state === "open") return null;
  if (state === "not-yet") return "Applications for this round have not opened yet.";
  return "Applications for this round have closed.";
}

export type LoadedApplication = {
  application: AdmissionApplicationDoc;
  accessRequirements: string;
};

/** The caller's own row plus its private sibling, or null when there is none. */
export async function loadOwnApplication(
  db: Db,
  round: AdmissionRoundDoc,
  uid: string,
): Promise<LoadedApplication | null> {
  const [appSnap, privateSnap] = await Promise.all([
    applicationRef(db, round.id, uid).get(),
    privateRef(db, round.id, uid).get(),
  ]);
  if (!appSnap.exists) return null;
  return {
    application: normalizeAdmissionApplication(
      appSnap.id,
      appSnap.data() ?? {},
      round.availabilityGrid,
    ),
    accessRequirements: privateSnap.exists
      ? normalizeAdmissionApplicationPrivate(privateSnap.id, privateSnap.data() ?? {})
          .accessRequirements
      : "",
  };
}
