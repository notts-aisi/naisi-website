import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATION_LIMITS,
  CIRCULATIONS_COLLECTION,
  circulationStaffUids,
  DEFAULT_REVIEW_CONFIG,
  NOTIFICATION_EVENTS,
  normalizeNotifications,
  normalizeReviewConfig,
  type CirculationDoc,
  type NotificationToggles,
  type ReviewConfig,
} from "@/lib/firestore/circulations";
import { slugId } from "@/lib/firestore/slugId";
import { validateSlots, type ReminderSlot } from "@/lib/reminders/slots";
import {
  normalizeWorksheet,
  sanitizeItems,
  WORKSHEET_LIMITS,
  WORKSHEETS_COLLECTION,
} from "@/lib/firestore/worksheets";
import {
  canCirculate,
  isAddressableId,
  isEligibleRecipient,
  parseRecipientUids,
  readRoles,
} from "@/lib/worksheets/access";
import { isAlreadyExists, mintRecipients, type MintResult } from "@/lib/worksheets/mint";
import { notifyWorksheetEvent } from "@/lib/worksheets/notify";

/**
 * SENDING A WORKSHEET: the route that turns a library document into a
 * circulation, a response document and a task per recipient, and a message.
 *
 * ── WHY NONE OF THIS CAN BE A CLIENT WRITE ──────────────────────────────────
 * `firestore.rules` closes `create` on `circulations`, on `responses` and on a
 * worksheet task's whole shape, and this route is the reason. Creating a
 * circulation names OTHER PEOPLE as staff (which grants them every recipient's
 * answers), mints tasks in the sender's name on other people's boards, and
 * sends mail. A rule can check a shape; it cannot check that the person named
 * as a reviewer agreed to be one, cannot write a hundred documents atomically,
 * and cannot send an email. So the permission (`circulateWorksheet`) is checked
 * here, `staffUids` is composed here, and the client writes none of it.
 *
 * ── THE COPY IS THE POINT ───────────────────────────────────────────────────
 * `items` is COPIED onto the circulation. Editing the library worksheet
 * afterwards changes nothing that has been sent, which is what makes a sent
 * worksheet answerable at all: answers are keyed by question id against this
 * frozen array, and a live pointer at the library document would rewrite the
 * questions under people who had already answered them.
 *
 * ── ORDER OF WRITES, AND WHAT SURVIVES A FAILURE ────────────────────────────
 * The circulation first, then the recipients, then the library's
 * `lastCirculatedAt`, then the mail. Each step is recoverable from the state
 * the one before it left:
 *   · circulation created, mint failed  → an empty circulation the sender can
 *     add people to from its own page, and a 500 that says so and names it;
 *   · mint done, stamp failed           → a cosmetic "last sent" date on the
 *     library card is wrong. Logged and swallowed; failing a send that has
 *     already happened over a decoration would be the worse answer;
 *   · everything done, mail failed      → counted inside the notifier, which
 *     never throws. The work exists and the tasks are on the boards.
 */

/** Fresh `slugId`s tried before a collision is allowed out as a 500. */
const CREATE_ATTEMPTS = 3;

type CreateBody = {
  worksheetId?: unknown;
  recipientUids?: unknown;
  reviewerUids?: unknown;
  dueDate?: unknown;
  reviewConfig?: unknown;
  notifications?: unknown;
  title?: unknown;
};

/**
 * The notification switches off the body: every key a real event, every value
 * a pair of booleans, or a named refusal.
 *
 * `normalizeNotifications` alone would silently accept `{ assigend: {...} }`
 * (a typo) by ignoring it and defaulting the real event to ON, which is the
 * one direction this must not fail in: the sender believes they turned a
 * message off. So unknown keys are a 400 and the normaliser only fills in the
 * events the body did not mention.
 *
 * `dueSoon` carries a third key, `slots`, which is its reminder SCHEDULE
 * (`src/lib/reminders/slots.ts`). It is checked the same strict way rather
 * than sanitised silently: `sanitizeSlots` repairs a list on the way out of
 * Firestore, which is right for a stored document and wrong for a request,
 * because a sender who asked for 09:00 and had it quietly dropped would be
 * told their worksheet went out with reminders it does not have.
 */
function parseNotifications(
  raw: unknown,
): { notifications: NotificationToggles } | { error: string } {
  if (raw === undefined || raw === null) {
    // Through the normaliser rather than a spread of the constant: the
    // schedule is an ARRAY, and a shallow copy would hand this circulation
    // the process-wide default rows.
    return { notifications: normalizeNotifications(undefined) };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Send `notifications` as a map of events to switches." };
  }
  const known = new Set<string>(NOTIFICATION_EVENTS);
  for (const [event, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(event)) {
      return { error: `"${event}" is not a notification a worksheet sends.` };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `The "${event}" switch has to be { email, push }.` };
    }
    const pair = value as Record<string, unknown>;
    for (const key of Object.keys(pair)) {
      if (key === "slots" && event === "dueSoon") continue;
      if (key !== "email" && key !== "push") {
        return { error: `"${key}" is not part of a notification switch.` };
      }
    }
    if (typeof pair.email !== "boolean" || typeof pair.push !== "boolean") {
      return { error: `The "${event}" switch has to be { email, push } booleans.` };
    }
    if (event === "dueSoon" && pair.slots !== undefined) {
      if (!Array.isArray(pair.slots)) {
        return { error: "Send the reminder times as a list." };
      }
      if (pair.slots.some((slot) => !slot || typeof slot !== "object")) {
        return { error: "Every reminder needs a number of days and a time." };
      }
      // The editor refuses to send a list `validateSlots` complains about, so
      // this is the hand-written request rather than the dialog. Its first
      // sentence is the honest 400: they are written for a person.
      const problems = validateSlots(pair.slots as ReminderSlot[]);
      if (problems.length > 0) return { error: problems[0] };
    }
  }
  return { notifications: normalizeNotifications(raw) };
}

/** An ISO instant, or null, or a named refusal. */
function parseDueDate(raw: unknown): { dueDate: Date | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { dueDate: null };
  if (typeof raw !== "string") {
    return { error: "Send `dueDate` as an ISO date string, or null." };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "That due date is not a date this can read." };
  }
  return { dueDate: parsed };
}

/** Names off a body: strings only, de-duplicated, order preserved. */
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

export async function POST(req: Request) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canCirculate(actor)) {
    return NextResponse.json(
      { error: "You need the worksheet-circulation permission to send a worksheet." },
      { status: 403 },
    );
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const worksheetId = typeof body.worksheetId === "string" ? body.worksheetId : "";
  if (!isAddressableId(worksheetId)) {
    return NextResponse.json({ error: "Worksheet not found" }, { status: 404 });
  }

  const snap = await db.collection(WORKSHEETS_COLLECTION).doc(worksheetId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Worksheet not found" }, { status: 404 });
  }
  const worksheet = normalizeWorksheet(snap.id, snap.data() ?? {});

  // THE SAME POLICY THE RULES ENFORCE ON A READ, restated because the Admin
  // SDK bypasses them: a private worksheet is readable by admins and its
  // author only. A holder of `circulateWorksheet` who cannot READ a worksheet
  // must not be able to SEND it, which is the strictly worse act.
  //
  // 404 rather than 403, matching the missing case exactly: a private
  // worksheet the caller may not see must not be distinguishable from one that
  // is not there, or the id becomes a way to enumerate what exists.
  const mayRead =
    !worksheet.private || actor.role === "admin" || worksheet.authorUid === actor.uid;
  if (!mayRead) {
    return NextResponse.json({ error: "Worksheet not found" }, { status: 404 });
  }

  const recipients = parseRecipientUids(body.recipientUids);
  if ("error" in recipients) {
    return NextResponse.json({ error: recipients.error }, { status: 400 });
  }

  const notifications = parseNotifications(body.notifications);
  if ("error" in notifications) {
    return NextResponse.json({ error: notifications.error }, { status: 400 });
  }

  const due = parseDueDate(body.dueDate);
  if ("error" in due) {
    return NextResponse.json({ error: due.error }, { status: 400 });
  }

  // THE SENDER IS ALWAYS A REVIEWER, first in the list. They are staff whatever
  // happens (`circulationStaffUids` puts them there anyway), and naming them a
  // reviewer as well is what puts the thing they sent in front of them when
  // somebody submits. Capped at the same five the tasks system allows, because
  // the reviewers become the task's reviewers.
  const namedReviewers = stringList(body.reviewerUids).filter((uid) => uid !== actor.uid);
  const reviewerUids = [actor.uid, ...namedReviewers].slice(
    0,
    CIRCULATION_LIMITS.maxReviewers,
  );

  // One read for both lists: the recipients are subject to the v1 policy line,
  // and so is anybody named as a reviewer, because a reviewer lands in
  // `staffUids` and staff read EVERY recipient's answers. The picker only ever
  // offers committee and admins, so this can only fire on a hand-made request,
  // and it is a refusal rather than a silent drop precisely because of what the
  // request was trying to do.
  const roles = await readRoles(db, [...recipients.uids, ...namedReviewers]);
  const ineligibleReviewer = namedReviewers.find(
    (uid) => !isEligibleRecipient(roles.get(uid) ?? null),
  );
  if (ineligibleReviewer) {
    return NextResponse.json(
      { error: "Reviewers have to be committee members or admins." },
      { status: 400 },
    );
  }

  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const uid of recipients.uids) {
    if (isEligibleRecipient(roles.get(uid) ?? null)) eligible.push(uid);
    else skipped.push(uid);
  }
  // A send where EVERYBODY was skipped still creates the circulation. The
  // settings the sender just filled in are worth more than the refusal, the
  // answer names every uid that was dropped, and adding people to an empty
  // circulation is one click from the page they land on.

  const title =
    (typeof body.title === "string" ? body.title : worksheet.title)
      .trim()
      .slice(0, WORKSHEET_LIMITS.title) || "Untitled worksheet";

  const reviewConfig: ReviewConfig =
    body.reviewConfig === undefined
      ? (worksheet.defaultReviewConfig ?? DEFAULT_REVIEW_CONFIG)
      : normalizeReviewConfig(body.reviewConfig);

  const now = new Date();
  // Re-sanitised at the write site even though `normalizeWorksheet` already
  // did it on the way in: this array is the copy people will answer for weeks,
  // and its provenance being visible here is worth one idempotent pass.
  const items = sanitizeItems(worksheet.items);
  const staffUids = circulationStaffUids({
    senderUid: actor.uid,
    authorUid: worksheet.authorUid,
    reviewerUids,
  });

  const payload = {
    worksheetId,
    title,
    description: worksheet.description,
    items,
    senderUid: actor.uid,
    authorUid: worksheet.authorUid,
    reviewerUids,
    staffUids,
    reviewConfig,
    notifications: notifications.notifications,
    dueDate: due.dueDate,
    status: "open",
    anonymity: "named",
    source: { kind: "worksheet" },
    recipientCount: 0,
    submittedCount: 0,
    reviewedCount: 0,
    itemsEditedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    closedAt: null,
  };

  // `create()` at a `slugId`, retried with a fresh id: the suffix is eight
  // base36 characters, so a collision is vanishingly unlikely and silently
  // OVERWRITING somebody else's circulation if one happened is not a risk to
  // carry for the sake of one line.
  let circulationId = "";
  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
    const candidate = slugId(title);
    try {
      await db.collection(CIRCULATIONS_COLLECTION).doc(candidate).create(payload);
      circulationId = candidate;
      break;
    } catch (err) {
      if (!isAlreadyExists(err) || attempt === CREATE_ATTEMPTS) {
        console.error("[worksheets circulate] create failed", worksheetId, err);
        return NextResponse.json(
          { error: "Couldn't create that circulation." },
          { status: 500 },
        );
      }
    }
  }

  // The same document, as the mint and the notifier read it: real Dates where
  // the payload above carries sentinels, and the id now that it is settled.
  const circulation: CirculationDoc = {
    id: circulationId,
    worksheetId,
    title,
    description: worksheet.description,
    items,
    senderUid: actor.uid,
    authorUid: worksheet.authorUid,
    reviewerUids,
    staffUids,
    reviewConfig,
    notifications: notifications.notifications,
    dueDate: due.dueDate,
    status: "open",
    // A brand new circulation is not being destroyed. The stored payload above
    // deliberately does not carry the field: the normaliser reads an absent
    // one as false, and writing it would put a destroy-protocol flag on every
    // circulation ever sent to say that nothing is happening to it.
    destroying: false,
    anonymity: "named",
    source: { kind: "worksheet" },
    recipientCount: 0,
    submittedCount: 0,
    reviewedCount: 0,
    itemsEditedAt: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };

  let minted: MintResult;
  try {
    minted = await mintRecipients(db, {
      circulation,
      circulationId,
      recipientUids: eligible,
      actorUid: actor.uid,
      now,
    });
  } catch (err) {
    console.error("[worksheets circulate] mint failed", circulationId, err);
    // The circulation EXISTS. Naming it is the difference between a sender who
    // can open it and add people, and one who sends it a second time.
    return NextResponse.json(
      {
        error:
          "The circulation was created but nobody was added to it. Open it and add people.",
        circulationId,
      },
      { status: 500 },
    );
  }

  try {
    await db.collection(WORKSHEETS_COLLECTION).doc(worksheetId).update({
      lastCirculatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // A date on a library card. Swallowed on purpose: see the module comment.
    console.error("[worksheets circulate] lastCirculatedAt stamp failed", worksheetId, err);
  }

  await notifyWorksheetEvent(db, {
    circulation,
    circulationId,
    event: "assigned",
    recipientUids: minted.added,
    actor: { uid: actor.uid, displayName: actor.displayName ?? "A NAISI organiser" },
    taskIds: minted.taskIds,
  });

  return NextResponse.json(
    {
      circulationId,
      added: minted.added.length,
      skipped: [...skipped, ...minted.skipped],
    },
    { status: 201 },
  );
}
