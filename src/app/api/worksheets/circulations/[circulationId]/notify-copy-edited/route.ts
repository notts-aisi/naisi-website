import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATIONS_COLLECTION,
  normalizeResponse,
  RESPONSES_SUBCOLLECTION,
} from "@/lib/firestore/circulations";
import { isAddressableId, isCirculationStaff, loadCirculation } from "@/lib/worksheets/access";
import { notifyWorksheetEvent } from "@/lib/worksheets/notify";

/**
 * "Tell them I changed it": the deliberate half of a mid-flight edit.
 *
 * ── WHY THE MESSAGE IS A BUTTON AND NOT A SIDE EFFECT OF SAVING ─────────────
 * The copy editor autosaves every few hundred milliseconds, so an edit is not
 * one event: rewording a question is a dozen writes and a typo fix is three.
 * Firing a broadcast off `itemsEditedAt` would mean either a mail per keystroke
 * or a scheduler holding a debounce nobody can see. So the editor stamps the
 * document and a person decides, once, whether the change was the kind other
 * people need to hear about. `docs/worksheets.md` gives the switch itself the
 * same treatment: `copyEdited` is the one notification that defaults OFF.
 *
 * ── WHO IS TOLD ─────────────────────────────────────────────────────────────
 * The people whose state is `started`, and only them. Somebody who has not
 * opened it will read the new questions when they do, and a message about a
 * change to something they have never seen is noise. Somebody who has submitted
 * is finished and cannot act on it, and telling them their questions moved
 * after they answered would read as an accusation nobody can answer. That is
 * the contract's line ("recipients who have started but not submitted") and it
 * is enforced here rather than in the caller, so the button cannot broadcast by
 * being pressed from somewhere else.
 *
 * ── A CLOSED CIRCULATION TELLS NOBODY ───────────────────────────────────────
 * The message this route sends says the questions have changed and is written
 * for somebody who is about to answer them. Once a circulation is closed the
 * submit route refuses everybody, so the same message would be asking people to
 * act on something they cannot act on, about a worksheet they have already been
 * shut out of. A 409 naming the reason, then, rather than a send: the person
 * pressing the button is allowed, the circulation simply has no audience left.
 * The copy editor keeps working on a closed circulation (fixing a typo in a
 * question staff will read alongside the answers is still worth doing) and it
 * hides this button instead.
 *
 * ── THE SWITCH IS CHECKED IN THE NOTIFIER, NOT HERE ─────────────────────────
 * `notifyWorksheetEvent` refuses an event whose email switch is off and reports
 * `skipped`, so a staff member who presses this with the switch off gets a
 * truthful zero rather than a send. Repeating that test here would be a second
 * copy of a rule that already has one home.
 */

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId } = await ctx.params;
  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }
  if (!isCirculationStaff(circulation, actor)) {
    return NextResponse.json(
      { error: "You can't send messages about this circulation." },
      { status: 403 },
    );
  }
  // After the staff check, so a stranger learns nothing about which
  // circulations exist or what state they are in.
  if (circulation.status !== "open") {
    return NextResponse.json(
      {
        error:
          "This circulation is closed, so nobody can answer it any more and there is nothing for them to do about a change.",
      },
      { status: 409 },
    );
  }

  // One equality clause on a subcollection, which needs no composite index and
  // reads only the people who are mid-way. The alternative (read them all and
  // filter here) would cost a document per recipient to discard most of them.
  const started = await db
    .collection(CIRCULATIONS_COLLECTION)
    .doc(circulationId)
    .collection(RESPONSES_SUBCOLLECTION)
    .where("state", "==", "started")
    .get();

  const recipientUids: string[] = [];
  const taskIds: Record<string, string> = {};
  for (const snap of started.docs) {
    const response = normalizeResponse(snap.id, snap.data() ?? {});
    recipientUids.push(response.uid);
    if (response.taskId) taskIds[response.uid] = response.taskId;
  }

  const result = await notifyWorksheetEvent(db, {
    circulation,
    circulationId,
    event: "copyEdited",
    recipientUids,
    actor: { uid: actor.uid, displayName: actor.displayName ?? "A NAISI organiser" },
    taskIds,
  });

  // `sent` is people actually emailed, so a zero with the switch off and a zero
  // with nobody mid-way are the same number to the caller on purpose: the page
  // reports what happened, and neither is a failure to report as one.
  //
  // `optedOut` is the one zero that is NOT interchangeable with those, which is
  // why it is carried out of the notifier rather than dropped here. The page
  // says "nobody is part-way through this worksheet right now" on a zero, and
  // that sentence is a claim about the recipients: it is false when there were
  // recipients and every one of them has switched the tasks row's email cell
  // off. A count of one message is not enough to tell those two apart, so the
  // route hands over both.
  return NextResponse.json({ sent: result.sent, optedOut: result.optedOut ?? 0 });
}
