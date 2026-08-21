import { NextResponse } from "next/server";
import {
  dispatchSends,
  parseStaffMessage,
  reserveSendSlot,
  sendCourseRunEmail,
} from "@/lib/email/courseFacilitatorEmails";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { courseRunChannel, normalizeCourseRun } from "@/lib/firestore/courses";
import { findRecipientsForChannel } from "@/lib/firestore/subscriptions";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { signToken } from "@/lib/signedTokens";

/**
 * EMAIL THE COHORT — the announcement lane. One message to everyone on a run:
 * "applications for term two open Monday", "the week 4 reading has changed".
 * The group email route is its operational twin; the two differ in who may
 * send, who receives, and — the part that matters legally — whether the
 * recipient can opt out.
 *
 * ── ONE MESSAGE PER RECIPIENT. NOT NEGOTIABLE. ──────────────────────────────
 * The dispatch at the bottom sends ONE `sendEmail` per address with a single
 * string `to`. Never an array, never a Cc. A cohort is up to 200 people; one
 * batched envelope would hand all 200 addresses to all 200 people. Sends run
 * through `dispatchSends`, which bounds how many are in flight and carries the
 * arithmetic that keeps a full-size send inside App Hosting's 60s request
 * timeout — a broadcast that outlives the request has already spent its
 * rate-limit slot and can only be retried by re-mailing everyone.
 *
 * ── WHO MAY SEND ────────────────────────────────────────────────────────────
 * The run's `runFacilitatorUids` ∪ its `trackLeadUids` ∪ admins. Facilitating
 * ONE GROUP of the run is deliberately not enough — a group facilitator mails
 * their own room through the group route; addressing the whole cohort is a
 * run-level act. Admissions reviewers get nothing here: admissions is a
 * separate lane from the cohort (locked decision), and reading applications has
 * never granted the ability to mail applicants.
 *
 * AUTHORIZATION RUNS BEFORE ANY EXISTENCE CHECK — a missing run and a run you
 * hold no role on are the same 403, so probing run ids discloses nothing (the
 * same non-disclosure `runAccess.ts` gives).
 *
 * ── WHO RECEIVES: SUBSCRIPTION *AND* ENROLMENT, INTERSECTED ─────────────────
 * The audience is the rows `findRecipientsForChannel(cohort:<runId>)` returns,
 * INTERSECTED with the members holding an ACTIVE `courseEnrolments` row on this
 * run. Both halves are load-bearing and NEITHER IS SUFFICIENT ALONE:
 *
 *  · The SUBSCRIPTION is what makes unsubscribe work. An enrolment-derived
 *    audience would silently re-mail everyone who clicked the footer link,
 *    because that link flips the row, not the enrolment.
 *  · The ENROLMENT is what makes the audience TRUE. A subscription row is NOT a
 *    membership claim this route may trust on its own: `/api/subscriptions` is
 *    public and unauthenticated, run ids are public (the apply page renders
 *    `runId` into the client), and a signed-in caller subscribing one of their
 *    own verified addresses is minted confirmed with no click. Before this
 *    check, one POST put a rejected applicant — or an anonymous stranger, after
 *    one confirmation click in their own inbox — on a cohort's announcement
 *    list. `isServerManagedChannel` now refuses `cohort:` at that endpoint;
 *    THIS is the half that does not depend on every future write path
 *    remembering to ask.
 *
 * GUEST ROWS ARE DROPPED, not merely unverified. An enrolment is uid-keyed, so a
 * guest row can never hold one, and no legitimate producer writes one —
 * allocation publish and the remove route only ever address `audience: "user"`.
 * Non-enrolled members and guest rows are both counted into `skipped` and logged
 * as COUNTS, never addresses.
 *
 * THE ENROLMENT FILTER RUNS BEFORE THE RECIPIENT CAP, deliberately. Cap first
 * and anyone able to add rows to the channel could hold a cohort's
 * announcements hostage by pushing the count past the ceiling — a refusal that,
 * by design, refuses the whole send. Counting the VERIFIED audience makes the
 * cap a statement about the cohort rather than about whoever wrote rows.
 *
 * ── THE `courses` CATEGORY: AN OPT-OUT, NOT AN OPT-IN ───────────────────────
 * `notifications.categories.courses` defaults FALSE like every other category,
 * and if this route required it to be true nobody would ever receive cohort
 * mail — nothing sets it on placement, and the audience would be empty on day
 * one. That is not what the toggle is for. The OPT-IN is the subscription row
 * (you were placed in a group; you consented by enrolling); the CATEGORY is the
 * opt-out layered on top. So the check below skips a recipient whose stored
 * prefs say `courses === false` under the modern `notifications` shape — an
 * explicit refusal by someone who saw the toggle — and treats absent as
 * "hasn't answered". `DEFAULT_NOTIFICATION_PREFS` in notifications.ts carries
 * the other half of this comment; change neither alone.
 *
 * COUPLED TO THE PROFILE FORM, and it has teeth: `ProfileForm` writes
 * `serialiseNotifications(...)` on every save, so once the "Course
 * announcements" toggle exists, saving the profile with it unticked stores an
 * explicit `false` and this route stops mailing that member. That is the
 * correct reading of an unticked box a member has seen — but it means the
 * toggle's DEFAULT STATE for an enrolled member is a product decision, not a
 * cosmetic one. The opt-out count is logged on every send (never with
 * addresses) and lands in the response's `skipped`, so a cohort quietly
 * dropping out of announcements shows up as "4 sent, 23 skipped" rather than
 * as silence.
 *
 * Suppression is honoured on top of that, and for a different reason: a bounce
 * or complaint is a deliverability fact that outranks every preference.
 *
 * ── THE 200 CAP FAILS THE REQUEST ───────────────────────────────────────────
 * `MAX_RECIPIENTS_PER_REQUEST` refuses rather than truncates. A partial cohort
 * send is the worst outcome available: it looks successful, and nobody can tell
 * which 200 of the 260 got the mail — least of all on a second attempt, which
 * would re-mail the same first 200. A run that outgrows the cap needs a chunked
 * sender with per-recipient bookkeeping, which is a different feature.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard ceiling per request. Beyond this the request FAILS — see the header. */
const MAX_RECIPIENTS_PER_REQUEST = 200;

/**
 * Sanity ceiling on the channel read, above the recipient cap on purpose: it
 * catches a malformed channel (or a future many-rows-per-member scheme) rather
 * than sizing a normal cohort. Exceeding it FAILS the request — see below.
 */
const MAX_CHANNEL_ROWS = 500;

const WINDOW_MS = 60 * 60 * 1000;
/**
 * Real sends per (sender, run) per hour. Not required by the P9 brief the way
 * the group cap is, but a duplicate broadcast is this route's characteristic
 * mistake — a double-clicked Send is 400 emails — and the same durable counter
 * was already here to use.
 */
const SENDS_PER_WINDOW = 3;
/** Test sends per (sender, run) per hour, on their own counter. */
const TEST_SENDS_PER_WINDOW = 10;

/** Same lifetime the newsletter gives its unsubscribe links. */
const UNSUB_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Same one-path-segment guard as `runAccess.ts` and P8. */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address. (Duplicated per route by house
 * convention.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/**
 * An EXPLICIT refusal, read off the raw stored prefs — deliberately not
 * `normaliseNotifications`, which collapses "absent" and "false" into the same
 * `false` and would turn every unanswered profile into an opt-out. Only the
 * modern `notifications` shape can carry this refusal; the legacy `newsletter`
 * shape predates the category entirely and never means "no" to it.
 */
function hasOptedOutOfCourseAnnouncements(data: Record<string, unknown>): boolean {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const notifications = profile.notifications;
  if (!notifications || typeof notifications !== "object") return false;
  const categories = (notifications as Record<string, unknown>).categories;
  if (!categories || typeof categories !== "object") return false;
  return (categories as Record<string, unknown>).courses === false;
}

/** The sender's own address, for a `testOnly` rehearsal. Never a body field. */
function ownAddressFor(
  data: Record<string, unknown>,
  sessionEmail: string | null,
  gmailOnly: boolean,
): string | null {
  const account = typeof data.email === "string" ? data.email.trim() : "";
  if (account) return account;
  const session = sessionEmail?.trim();
  if (session) return session;
  if (gmailOnly) return null;
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const uni = typeof profile.universityEmail === "string" ? profile.universityEmail.trim() : "";
  return uni && profile.uniEmailVerifiedAt ? uni : null;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

/**
 * ALWAYS A MEMBER. Every recipient of a cohort announcement has an active
 * enrolment on the run (see the module comment), and an enrolment is uid-keyed,
 * so there is no guest shape here and no email-shape unsubscribe token: a uid
 * token flips the cohort row for BOTH of that member's addresses, which an
 * email-shape token could not.
 */
type Recipient = {
  uid: string;
  address: string;
  recipientName: string;
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  if (!isAddressableId(runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE, and before the body is parsed.
  const runSnap = await db.collection("courseRuns").doc(runId).get();
  const run = runSnap.exists
    ? normalizeCourseRun(runSnap.id, runSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const staffsRun = Boolean(
    run &&
      (run.runFacilitatorUids.includes(actor.uid) ||
        run.trackLeadUids.includes(actor.uid)),
  );
  if (!isAdmin && !staffsRun) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  }
  const parsed = parseStaffMessage(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { subject, body, testOnly } = parsed.value;

  const gmailOnly = process.env.EMAIL_GMAIL_ONLY_MODE === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const channel = courseRunChannel(runId);

  const actorSnap = await db.collection("users").doc(actor.uid).get();
  const actorData = actorSnap.data() ?? {};
  const senderName = actorSnap.exists
    ? displayNameOf(actorData)
    : actor.displayName?.trim() || "NAISI member";

  let skipped = 0;
  let recipients: Recipient[] = [];

  if (testOnly) {
    const own = ownAddressFor(actorData, actor.email, gmailOnly);
    if (!own) {
      return NextResponse.json(
        { error: "Your account has no email address on file to send a test to." },
        { status: 400 },
      );
    }
    recipients = [{ uid: actor.uid, address: own, recipientName: senderName }];
  } else {
    const rows = await findRecipientsForChannel(db, channel);
    // Refuse rather than slice. A `slice()` here would be a silent truncation
    // wearing a cost-ceiling costume: dedupe runs AFTER it, so a cohort with
    // enough second-address rows could fall under the 200 cap having already
    // lost people, and the send would look complete. Unreachable in practice
    // (one row per member) — which is exactly why it must fail loudly if it
    // ever happens.
    if (rows.length > MAX_CHANNEL_ROWS) {
      console.error(
        "[courses run email] channel row count exceeds ceiling",
        runId,
        rows.length,
      );
      return NextResponse.json(
        {
          error:
            "This cohort's subscriber list is larger than a single send can handle. " +
            "Nothing was sent — raise it with an admin.",
        },
        { status: 400 },
      );
    }

    // Dedupe at the RECIPIENT level, not the address level: a member with both
    // a claimed guest row and a user row must get one email, not two. Same
    // guard the newsletter route carries.
    const seenAudience = new Set<string>();
    const seenAddress = new Set<string>();
    type Pending = { uid: string; audience: "user" | "guest"; address: string };
    const pending: Pending[] = [];
    for (const row of rows) {
      const dedupKey = `${row.audience}:${row.audienceId}`;
      if (seenAudience.has(dedupKey)) continue;
      seenAudience.add(dedupKey);
      const address = row.email.trim();
      if (!address) {
        skipped += 1;
        continue;
      }
      const addressKey = address.toLowerCase();
      if (seenAddress.has(addressKey)) {
        skipped += 1;
        continue;
      }
      seenAddress.add(addressKey);
      pending.push({
        uid: row.audience === "user" ? row.audienceId : "",
        audience: row.audience,
        address,
      });
    }

    // ── THE SUBSCRIPTION ROW IS NOT AUTHORITY. RE-VERIFY THE ENROLMENT. ─────
    // `courseEnrolmentId(runId, uid)` is deterministic, so this is ONE addressed
    // `getAll` over the deduped audience — no query, no index, one read per
    // candidate, bounded by MAX_CHANNEL_ROWS above. It runs BEFORE the recipient
    // cap on purpose (see the module comment): the cap has to count the cohort,
    // not whoever managed to write rows.
    const guestRows = pending.filter((p) => p.audience !== "user" || !p.uid);
    if (guestRows.length > 0) {
      skipped += guestRows.length;
      // A guest row on a cohort channel has no legitimate producer. Counted and
      // logged as an anomaly worth noticing, never as an address.
      console.warn(
        "[courses run email] guest rows on a cohort channel, dropped",
        runId,
        guestRows.length,
      );
    }
    const memberPending = pending.filter((p) => p.audience === "user" && p.uid);
    const pendingByEnrolmentId = new Map<string, Pending>();
    for (const p of memberPending) {
      pendingByEnrolmentId.set(courseEnrolmentId(runId, p.uid), p);
    }
    const enrolmentIds = [...pendingByEnrolmentId.keys()];
    const enrolmentDocs = enrolmentIds.length
      ? await db.getAll(
          ...enrolmentIds.map((id) => db.collection("courseEnrolments").doc(id)),
        )
      : [];
    // Keyed by doc id rather than by result order, so this doesn't rest on
    // `getAll` returning documents in the order they were requested.
    const enrolled: Pending[] = [];
    for (const doc of enrolmentDocs) {
      if (!doc.exists) continue;
      const p = pendingByEnrolmentId.get(doc.id);
      if (!p) continue;
      const enrolment = normalizeCourseEnrolment(doc.id, doc.data() ?? {});
      // `runId` and `uid` are re-read off the document rather than inferred from
      // the id the lookup was built from — the id is construct-only by contract,
      // and a row that disagrees with it is not one to mail on.
      if (
        enrolment.status === "active" &&
        enrolment.runId === runId &&
        enrolment.uid === p.uid
      ) {
        enrolled.push(p);
      }
    }
    const notEnrolled = memberPending.length - enrolled.length;
    if (notEnrolled > 0) {
      skipped += notEnrolled;
      // Counts only. A non-zero value here is either a stale row (someone left
      // and the remove route's unsubscribe failed) or an attempt to join a
      // cohort by subscribing to it — both worth seeing, neither worth naming.
      console.warn(
        "[courses run email] subscribed rows with no active enrolment, skipped",
        runId,
        notEnrolled,
      );
    }

    // REFUSE, don't truncate. Counted on the deduped, ENROLMENT-VERIFIED
    // audience, before any preference filtering, so the answer doesn't wobble
    // with who has opted out this week. See the module comment.
    if (enrolled.length > MAX_RECIPIENTS_PER_REQUEST) {
      return NextResponse.json(
        {
          error:
            `This cohort has ${enrolled.length} subscribers, over the ${MAX_RECIPIENTS_PER_REQUEST}-recipient ` +
            "limit for a single send. Nothing was sent — split the announcement or raise it with an admin.",
        },
        { status: 400 },
      );
    }

    // Names + the opt-out check, one `getAll` over the verified members.
    const memberUids = enrolled.map((p) => p.uid);
    const userDocs = memberUids.length
      ? await db.getAll(...memberUids.map((uid) => db.collection("users").doc(uid)))
      : [];
    const dataByUid = new Map<string, Record<string, unknown>>();
    for (const doc of userDocs) {
      if (doc.exists) dataByUid.set(doc.id, doc.data() ?? {});
    }

    let optedOut = 0;
    for (const p of enrolled) {
      const data = dataByUid.get(p.uid);
      if (!data) {
        // Subscribed row whose account is gone. Skip rather than mail an
        // address we can no longer attribute to a member.
        skipped += 1;
        continue;
      }
      if (hasOptedOutOfCourseAnnouncements(data)) {
        optedOut += 1;
        skipped += 1;
        continue;
      }
      recipients.push({
        uid: p.uid,
        address: p.address,
        recipientName: displayNameOf(data),
      });
    }

    // Counts only, never addresses. A cohort where this climbs is the signal
    // that the profile toggle's default is wrong — see the module comment.
    if (optedOut > 0) {
      console.log(
        "[courses run email] recipients opted out of course announcements",
        runId,
        optedOut,
      );
    }
  }

  if (recipients.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  const { suppressed } = await filterSuppressed(
    db,
    recipients.map((r) => r.address),
  );
  const suppressedSet = new Set(suppressed.map((a) => a.toLowerCase()));
  const deliverable = recipients.filter(
    (r) => !suppressedSet.has(r.address.toLowerCase()),
  );
  skipped += recipients.length - deliverable.length;
  if (deliverable.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped });
  }

  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `run${testOnly ? "test" : ""}__${runId}__${actor.uid}`,
      limit: testOnly ? TEST_SENDS_PER_WINDOW : SENDS_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    // Fail CLOSED — see the group route.
    console.error("[courses run email] throttle read failed", runId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      {
        error: testOnly
          ? "Too many test sends for this run in the last hour."
          : `You can send ${SENDS_PER_WINDOW} announcements an hour to this cohort. Try again shortly.`,
      },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  let sent = 0;
  // Bounded concurrency, not a sequential sleep — `dispatchSends` carries the
  // wall-clock arithmetic against App Hosting's 60s request timeout, which a
  // full-size cohort send would otherwise blow through with the rate-limit slot
  // already spent.
  await dispatchSends(deliverable, async (recipient) => {
    // One token per recipient, scoped to THIS run's channel: clicking it drops
    // the cohort and nothing else. The token addresses the UID, so the
    // unsubscribe route flips the rows for both of that member's addresses.
    const token = signToken(
      { s: "unsubscribe", uid: recipient.uid, c: channel },
      UNSUB_TOKEN_TTL_SECONDS,
    );
    const unsubscribeUrl = `${appUrl}/api/unsubscribe?t=${encodeURIComponent(token)}`;

    try {
      // ONE address. One message. See the module comment.
      await sendCourseRunEmail({
        to: recipient.address,
        subject,
        body,
        senderName,
        actorUid: actor.uid,
        test: testOnly,
        runId,
        recipientName: recipient.recipientName,
        courseTitle: run.courseTitle || null,
        runLabel: run.label || null,
        unsubscribeUrl,
      });
      sent += 1;
    } catch (err) {
      // Uid only — an address must not reach the logs.
      console.error("[courses run email] send failed", runId, recipient.uid, err);
      skipped += 1;
    }
  });

  return NextResponse.json({ ok: true, sent, skipped });
}
