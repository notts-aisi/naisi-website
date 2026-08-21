import { NextResponse } from "next/server";
import {
  dispatchSends,
  parseStaffMessage,
  reserveSendSlot,
  sendCourseGroupEmail,
} from "@/lib/email/courseFacilitatorEmails";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import { filterSuppressed } from "@/lib/firestore/suppression";

/**
 * EMAIL MY GROUP — the operational lane. "We're in B52 this week", "bring the
 * Amodei piece", "no session Tuesday". One message per member, composed by
 * their facilitator, sent through the same pipeline everything else uses.
 *
 * ── ONE MESSAGE PER RECIPIENT. NOT NEGOTIABLE. ──────────────────────────────
 * The dispatch at the bottom sends ONE `sendEmail` per address and passes a
 * single string as `to`. It must never be handed an array, and no Cc/Bcc goes
 * near it. Batching a group into one envelope would disclose every member's
 * address to every other member — the single worst failure this feature can
 * ship, and the exact disclosure the PII-free roster route exists to prevent.
 * Pacing is `dispatchSends`, shared with the run route: a bounded number in
 * flight so a send doesn't burst the SMTP relay, sized so a full-size send
 * finishes well inside App Hosting's request timeout. The arithmetic lives on
 * that helper.
 *
 * ── THE MEMBER CAP REFUSES, IT DOES NOT TRUNCATE ────────────────────────────
 * A group over `MAX_MEMBERS` FAILS the request. Nothing bounds a group below
 * that number (`capacity` is `number | null`), and the run route makes the
 * argument for both of us: a partial send is the worst outcome available,
 * because it looks successful — an arbitrary hundred get the mail, the answer
 * says `sent: 100, skipped: 0`, the composer says nobody was skipped, and a
 * retry re-mails the same hundred.
 *
 * ── WHO MAY SEND ────────────────────────────────────────────────────────────
 * A facilitator of THIS group while it is LIVE, ∪ admins. Identical to the P8
 * review queue, down to the ordering: ARCHIVING A GROUP UNSTAFFS IT, and
 * AUTHORIZATION RUNS BEFORE ANY EXISTENCE CHECK, so a missing group, an
 * archived group and someone else's group collapse onto ONE indistinguishable
 * 403. Being a run facilitator, a track lead, or an admissions reviewer grants
 * nothing here — those roles address the run, not the room (see the run email
 * route). Members cannot mail their own group at all: a peer lane is a
 * different feature with a different consent model.
 *
 * ── WHO RECEIVES ────────────────────────────────────────────────────────────
 * The ACTIVE enrolled members of this group, derived server-side from the
 * group's own enrolment rows. The caller passes no uids and no addresses, so
 * this route cannot be steered into mailing anyone outside the room, and it
 * never hands an address back — `sent`/`skipped` are counts, and even the
 * console lines log uids, never addresses.
 *
 * ── SUBSCRIPTION vs SUPPRESSION (the distinction that matters) ──────────────
 * This is OPERATIONAL mail, so it does NOT require the marketing subscription
 * or the `courses` notification category: a member who has opted out of
 * announcements still needs to know their session moved. That is also why it
 * carries no unsubscribe footer — matching every other transactional path in
 * the estate (task membership, RSVP, collaborator lifecycle), none of which
 * offers one. The opt-outable lane is the run announcement route, which does
 * carry both the footer and the RFC 8058 headers.
 *
 * SUPPRESSION IS DIFFERENT AND IS ALWAYS HONOURED. A bounced or complained
 * address is a DELIVERABILITY fact, not a preference: continuing to send to it
 * damages the domain's reputation for every other recipient, and a complaint
 * is a request we are obliged to respect whatever the mail's category. A
 * suppressed address is skipped and counted, never sent to.
 *
 * ── RATE LIMIT ──────────────────────────────────────────────────────────────
 * 3 real sends per hour per (sender, group), plus a separate, looser bucket for
 * test sends so rehearsing a message never eats the budget for sending it.
 * Both counters are Firestore transactions, not `lib/rateLimit`'s in-memory
 * map — see `reserveSendSlot` for why an outbound-mail cap cannot be
 * per-instance.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Same cap the roster + review-queue routes apply — a group is small by design.
 * Here it is a REFUSAL threshold, not a slice: the query below asks for
 * `MAX_MEMBERS + 1` so an oversized group is DETECTABLE, and the request fails.
 * See the module comment.
 */
const MAX_MEMBERS = 100;

const WINDOW_MS = 60 * 60 * 1000;
/** Real sends per (sender, group) per hour. */
const SENDS_PER_WINDOW = 3;
/**
 * Test sends per (sender, group) per hour, on their OWN counter. A rehearsal
 * reaches one inbox — the sender's — so it earns a looser cap than a send to
 * the whole room; but it is still real mail through the production sender, so
 * it is not uncapped.
 */
const TEST_SENDS_PER_WINDOW = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw. Same guard as `runAccess.ts` and P8.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address. Used only for the sender's
 * name in the signature line here, but duplicated per route by house
 * convention so no route inherits another's PII assumptions.
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
 * ONE address per member, never two.
 *
 * The newsletter fans out to both of a subscriber's addresses via
 * `addressesForSend`, because the gmail/uniEmail channel toggles are a
 * SUBSCRIPTION routing preference. Operational mail deliberately does not:
 * sending "your room changed" twice to the same person is noise, and honouring
 * a channel toggle here could make a member who unticked "Google account
 * email" unreachable for a message they need. So the account address (the
 * Google sign-in identity, always present and always verified) is the target,
 * and a VERIFIED university email is the fallback for the rare account that
 * has no `email` field.
 *
 * `EMAIL_GMAIL_ONLY_MODE` suppresses the university fallback for the same
 * deliverability reason the newsletter honours it.
 */
function deliveryAddressFor(
  data: Record<string, unknown>,
  gmailOnly: boolean,
): string | null {
  const account = typeof data.email === "string" ? data.email.trim() : "";
  if (account) return account;
  if (gmailOnly) return null;
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const uni = typeof profile.universityEmail === "string" ? profile.universityEmail.trim() : "";
  return uni && profile.uniEmailVerifiedAt ? uni : null;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

type Recipient = { uid: string; address: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE EXISTENCE, and before the body is even parsed: an
  // unauthorized caller learns nothing about the group id they guessed, and
  // nothing about what a valid payload looks like.
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  if (!group.runId) {
    return NextResponse.json(
      { error: "Group is not attached to a run" },
      { status: 400 },
    );
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

  // Exact match for the existing (runId, groupId, status) composite index —
  // the same query the roster and review-queue routes run, scoped by the
  // GROUP's own runId and never a caller parameter. A facilitator's own
  // enrolment carries a null groupId, so it isn't in here: nobody mails
  // themselves a copy of their own announcement.
  //
  // `MAX_MEMBERS + 1`, deliberately: the extra row is the ONLY way an oversized
  // group is distinguishable from one that exactly fits, and without it the
  // send silently mails an arbitrary hundred and reports a clean success. One
  // extra read buys the refusal below.
  const memberQuery = db
    .collection("courseEnrolments")
    .where("runId", "==", group.runId)
    .where("groupId", "==", groupId)
    .where("status", "==", "active")
    .limit(MAX_MEMBERS + 1);

  // The run doc is context for the signature line ONLY — it authorizes
  // nothing (see the module comment), and a missing one degrades to the group
  // name alone rather than failing a send.
  const [runSnap, actorSnap, memberSnap] = await Promise.all([
    db.collection("courseRuns").doc(group.runId).get(),
    db.collection("users").doc(actor.uid).get(),
    testOnly ? Promise.resolve(null) : memberQuery.get(),
  ]);

  const run = runSnap.exists
    ? normalizeCourseRun(runSnap.id, runSnap.data() ?? {})
    : null;
  const actorData = actorSnap.data() ?? {};
  const senderName = actorSnap.exists
    ? displayNameOf(actorData)
    : actor.displayName?.trim() || "NAISI member";

  // `skipped` accumulates every recipient this request did NOT deliver to, for
  // any reason — no address on file, suppressed, or a send that threw. The
  // composer shows it next to `sent` so "12 sent, 1 skipped" prompts the
  // question rather than hiding it.
  let skipped = 0;
  let recipients: Recipient[] = [];

  if (testOnly) {
    // A rehearsal reaches the SENDER and nobody else. Their session address
    // is the target — never an address from the request body, which is what
    // keeps `testOnly` from being a way to mail arbitrary people through a
    // facilitator's authorization.
    const own =
      deliveryAddressFor(actorData, gmailOnly) ?? actor.email?.trim() ?? null;
    if (!own) {
      return NextResponse.json(
        { error: "Your account has no email address on file to send a test to." },
        { status: 400 },
      );
    }
    recipients = [{ uid: actor.uid, address: own }];
  } else {
    const memberDocs = memberSnap?.docs ?? [];
    // REFUSE, don't truncate — the run route's stance, for the run route's
    // reason (see both module comments). Checked before the rate-limit slot is
    // claimed and before a single message goes out, so a refused send costs the
    // facilitator nothing but the error.
    if (memberDocs.length > MAX_MEMBERS) {
      return NextResponse.json(
        {
          error:
            `This group has more than ${MAX_MEMBERS} active members, over the limit for a ` +
            "single send. Nothing was sent — split the group or raise it with an admin.",
        },
        { status: 400 },
      );
    }
    const memberUids = memberDocs
      .map((d) => normalizeCourseEnrolment(d.id, d.data() ?? {}).uid)
      .filter(Boolean);
    const userDocs = memberUids.length
      ? await db.getAll(...memberUids.map((uid) => db.collection("users").doc(uid)))
      : [];

    const seen = new Set<string>();
    for (const doc of userDocs) {
      if (!doc.exists) {
        skipped += 1;
        continue;
      }
      const address = deliveryAddressFor(doc.data() ?? {}, gmailOnly);
      if (!address) {
        skipped += 1;
        continue;
      }
      // Belt-and-braces: two enrolments resolving to one address would
      // otherwise mean two identical emails to the same inbox.
      const key = address.toLowerCase();
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      recipients.push({ uid: doc.id, address });
    }
  }

  if (recipients.length === 0) {
    // Nothing to send: don't spend a rate-limit slot on it.
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

  // Claim the slot immediately before dispatch, so a request that dies mid-send
  // has still spent it (see `reserveSendSlot`). Test sends draw on their own
  // counter, so proofing a message never rations sending it.
  let slot;
  try {
    slot = await reserveSendSlot(db, {
      key: `group${testOnly ? "test" : ""}__${groupId}__${actor.uid}`,
      limit: testOnly ? TEST_SENDS_PER_WINDOW : SENDS_PER_WINDOW,
      windowMs: WINDOW_MS,
    });
  } catch (err) {
    // Fail CLOSED. A throttle that can't be read is not a licence to send.
    console.error("[courses group email] throttle read failed", groupId, err);
    return NextResponse.json(
      { error: "Could not check the send limit. Try again in a moment." },
      { status: 500 },
    );
  }
  if (!slot.ok) {
    return NextResponse.json(
      {
        error: testOnly
          ? "Too many test sends for this group in the last hour."
          : `You can send ${SENDS_PER_WINDOW} emails an hour to this group. Try again shortly.`,
      },
      { status: 429, headers: { "Retry-After": String(slot.retryAfterSeconds) } },
    );
  }

  let sent = 0;
  // Bounded concurrency, not a sequential sleep — `dispatchSends` carries the
  // wall-clock arithmetic against App Hosting's 60s request timeout, which the
  // slot above has already been spent against by the time the loop starts.
  await dispatchSends(deliverable, async (recipient) => {
    try {
      // ONE address. One message. See the module comment.
      await sendCourseGroupEmail({
        to: recipient.address,
        subject,
        body,
        senderName,
        actorUid: actor.uid,
        test: testOnly,
        groupId,
        groupName: group.name,
        courseTitle: run?.courseTitle ?? null,
        runLabel: run?.label ?? null,
      });
      sent += 1;
    } catch (err) {
      // Uid only — an address must not reach the logs.
      console.error("[courses group email] send failed", groupId, recipient.uid, err);
      skipped += 1;
    }
  });

  return NextResponse.json({ ok: true, sent, skipped });
}
