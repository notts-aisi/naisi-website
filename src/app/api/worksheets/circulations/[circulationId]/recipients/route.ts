import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  canCirculate,
  isAddressableId,
  isCirculationStaff,
  isEligibleRecipient,
  loadCirculation,
  parseRecipientUids,
  readRoles,
} from "@/lib/worksheets/access";
import { mintRecipients } from "@/lib/worksheets/mint";
import { notifyWorksheetEvent } from "@/lib/worksheets/notify";

/**
 * Adding people to a circulation that is already out.
 *
 * The same mint and the same message as the circulate route, behind a
 * DIFFERENT gate: staff of this circulation AND a holder of
 * `circulateWorksheet`. Both halves are load-bearing.
 *  · Staff alone is not enough, because staff includes every named reviewer,
 *    and being asked to read somebody's answers is not being given the right
 *    to send the worksheet to more people.
 *  · The permission alone is not enough either, or anybody who could send a
 *    worksheet could add recipients to somebody else's circulation, which is a
 *    way to put another person's name on the message that arrives.
 *
 * OPEN ONLY. A closed circulation takes no further submissions, so adding
 * somebody to one would hand them a task they cannot finish. 409 rather than
 * 403: the caller is allowed, the circulation is simply shut.
 *
 * IDEMPOTENT BY CONSTRUCTION. Somebody already on the list is reported in
 * `skipped` and nothing about their response is touched, so the "add everyone"
 * button being pressed twice cannot wipe an answer half-typed between the two
 * presses (see `mintRecipients`).
 */

export async function POST(
  req: Request,
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

  let body: { recipientUids?: unknown };
  try {
    body = (await req.json()) as { recipientUids?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  // Both halves, in one refusal: which of the two the caller is missing is not
  // information a stranger poking at circulation ids should be able to collect.
  if (!isCirculationStaff(circulation, actor) || !canCirculate(actor)) {
    return NextResponse.json(
      { error: "You can't add people to this circulation." },
      { status: 403 },
    );
  }

  if (circulation.status !== "open") {
    return NextResponse.json(
      { error: "This circulation is closed, so nobody else can be added to it." },
      { status: 409 },
    );
  }

  const recipients = parseRecipientUids(body.recipientUids);
  if ("error" in recipients) {
    return NextResponse.json({ error: recipients.error }, { status: 400 });
  }

  // The v1 policy line, read from the live user documents rather than from
  // anything the browser sent. Same helper as the circulate route, so the two
  // doors cannot come to disagree about who may be sent a worksheet.
  const roles = await readRoles(db, recipients.uids);
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const uid of recipients.uids) {
    if (isEligibleRecipient(roles.get(uid) ?? null)) eligible.push(uid);
    else skipped.push(uid);
  }

  let minted;
  try {
    minted = await mintRecipients(db, {
      circulation,
      circulationId,
      recipientUids: eligible,
      actorUid: actor.uid,
      now: new Date(),
    });
  } catch (err) {
    console.error("[worksheets add-recipients] mint failed", circulationId, err);
    return NextResponse.json({ error: "Couldn't add those people." }, { status: 500 });
  }

  // Only the people who were actually added hear about it. Somebody who was
  // already on the list must not get a second "you've been sent this".
  await notifyWorksheetEvent(db, {
    circulation,
    circulationId,
    event: "assigned",
    recipientUids: minted.added,
    actor: { uid: actor.uid, displayName: actor.displayName ?? "A NAISI organiser" },
    taskIds: minted.taskIds,
  });

  return NextResponse.json({
    added: minted.added.length,
    skipped: [...skipped, ...minted.skipped],
  });
}
