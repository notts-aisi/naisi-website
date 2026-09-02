import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import {
  CONDUCT_FLAG_FIELD_LIMITS,
  conductFlagForQueue,
  normalizeMemberConductFlag,
} from "@/lib/firestore/memberConductFlags";

/**
 * The conduct flag on one member: the only writer of `memberConductFlags/{uid}`.
 *
 * ## Why a route at all
 *
 * The collection is `allow read, write: if false`, admins included, so there is
 * no client path to it and this file is the whole surface. That is deliberate:
 * the row carries a free-text allegation about a named student, and the person
 * it describes must never be able to read it from a browser. The flag is not a
 * field on `users/{uid}` because that document is own-row readable and
 * `AuthProvider` holds a live `onSnapshot` on it, so a reason written there
 * would stream into the flagged member's own browser on every authed page and
 * could expose whoever reported them.
 *
 * ## Clearing deletes the row
 *
 * Unflagging deletes the document rather than writing `flagged: false`.
 * `conductChip(null)` already returns `{ flagged: false }`, so ABSENCE is the
 * cleared state everywhere that reads this collection, and a cleared-but-kept
 * row would retain the allegation text with nothing left pointing at it. The
 * account-deletion sweep is an addressed delete at the same id, so a cleared
 * flag and a deleted account leave exactly the same nothing behind.
 *
 * ## What each caller gets back
 *
 * Both handlers answer with `conductFlagForQueue(flag, true)` and nothing
 * beside it, because only an admin reaches either handler. The projection is
 * the whole body: a handler that spread it and added a sibling key would have
 * moved the "what may this viewer see" decision out of the one function that
 * makes it, and the next payload to copy the shape may be a reviewer's.
 * Reviewers never call this route: they receive
 * `conductFlagForQueue(flag, false)`, a boolean and nothing else, inside the
 * queue payload their own route builds.
 *
 * ## What is retained, and what is not
 *
 * NO AUDIT TRAIL OF SET AND CLEAR, and that is a decision rather than an
 * oversight. The row itself carries who set the flag and when, so a live flag
 * is answerable; but re-wording a reason overwrites the old wording, and
 * clearing a flag deletes the row outright, leaving nothing that says a flag
 * was ever there. The alternative is a permanent record of an allegation
 * against a named student that survives the admins deciding it was wrong,
 * which is the thing this collection exists to avoid handing around. Setting a
 * flag on an already-flagged member therefore UPDATES THE REASON ONLY and
 * keeps the original `at`, `byUid` and `byName`, so correcting a typo does not
 * re-date somebody's record or reassign it to whoever happened to fix the
 * wording. Whether a set and a clear should also append a `courseAudit`-style
 * row is the owner's call, not this route's.
 */

type Ctx = { params: Promise<{ uid: string }> };

const COLLECTION = "memberConductFlags";

/**
 * Control characters out, surrounding whitespace trimmed, capped at the shared
 * limit. The reason is plain text and is rendered as a text node, never as
 * markup.
 *
 * NEWLINES SURVIVE. `MemberText` renders with `pre-wrap`, so an admin who
 * typed "what happened" on one line and "when" on the next gets back what they
 * typed. Carriage returns are folded into newlines first so a Windows browser
 * does not leave a stray control character behind, every other control
 * character becomes a space, and a run of three or more blank-ish newlines
 * collapses to one blank line so a paste cannot stretch the Members row.
 */
function cleanReason(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, CONDUCT_FLAG_FIELD_LIMITS.reason);
}

type Gate = { actor: SessionUser; error: null } | { actor: null; error: NextResponse };

async function requireAdmin(): Promise<Gate> {
  const actor = await getCurrentUser();
  if (!actor) {
    return {
      actor: null,
      error: NextResponse.json({ error: "Not signed in" }, { status: 401 }),
    };
  }
  if (actor.role !== "admin") {
    return {
      actor: null,
      error: NextResponse.json(
        {
          error:
            "Only an admin can see or change a conduct flag. Reviewers are told whether a flag exists, never why.",
        },
        { status: 403 },
      ),
    };
  }
  return { actor, error: null };
}

/**
 * The current flag, for the admin Members row. There is no client read of this
 * collection by design, so without this handler the row would have no way to
 * show the state it is about to change.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const { uid } = await ctx.params;
  if (!uid) return NextResponse.json({ error: "Missing uid" }, { status: 400 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  try {
    const snap = await db.collection(COLLECTION).doc(uid).get();
    const flag = snap.exists ? normalizeMemberConductFlag(uid, snap.data() ?? {}) : null;
    return NextResponse.json(conductFlagForQueue(flag, true));
  } catch (err) {
    console.error("[conduct-flag] read failed:", uid, err);
    return NextResponse.json({ error: "Could not read the conduct flag." }, { status: 500 });
  }
}

/**
 * Set or clear the flag. `{ flagged: true, reason }` writes the row, and the
 * reason is required: a flag with no reason is one a reviewer would act on and
 * nobody could later explain. Sending it again for a member who is already
 * flagged rewrites the reason and leaves the original date and author alone,
 * which is how an admin corrects the wording without re-dating the record.
 * `{ flagged: false }` deletes the row and ignores any reason sent alongside
 * it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const actor = gate.actor;

  const { uid } = await ctx.params;
  if (!uid) return NextResponse.json({ error: "Missing uid" }, { status: 400 });

  // An admin cannot flag or unflag themselves. The flag is a record one person
  // keeps about another, and a self-set one is a record with nobody outside it
  // who agreed to it. Another admin can still flag this one: the refusal is
  // about the actor being the subject, not about the subject's role. The
  // Members row hides the control on the admin's own row for the same reason,
  // and this is the half that a hand-made request meets.
  if (uid === actor.uid) {
    return NextResponse.json(
      { error: "You cannot flag your own account. Ask another admin." },
      { status: 400 },
    );
  }

  let body: { flagged?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.flagged !== "boolean") {
    return NextResponse.json({ error: "Flagged must be true or false." }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const ref = db.collection(COLLECTION).doc(uid);

  if (!body.flagged) {
    try {
      await ref.delete();
      return NextResponse.json(conductFlagForQueue(null, true));
    } catch (err) {
      console.error("[conduct-flag] clear failed:", uid, err);
      return NextResponse.json(
        { error: "Could not clear the conduct flag." },
        { status: 500 },
      );
    }
  }

  const reason = cleanReason(body.reason);
  if (!reason) {
    return NextResponse.json(
      {
        error:
          "Give a reason. A flag with no reason is one a reviewer would act on and nobody could later explain.",
      },
      { status: 400 },
    );
  }

  try {
    // The member has to exist. Flagging a uid with no account would leave a row
    // the account-deletion sweep can never reach, because that sweep runs off
    // the account being deleted.
    const member = await db.collection("users").doc(uid).get();
    if (!member.exists) {
      return NextResponse.json({ error: "No member with that id." }, { status: 404 });
    }

    const existing = await ref.get();
    const alreadyFlagged = existing.exists && existing.data()?.flagged === true;

    if (alreadyFlagged) {
      // Re-wording a live flag is a correction, not a new flag, so only the
      // reason moves: `at`, `byUid` and `byName` stay as they were set. A
      // typo fix that re-dated the record would make the flag look fresher
      // than it is to everyone who reads the date afterwards.
      await ref.update({ reason });
    } else {
      // Every field written explicitly and not one of them possibly undefined,
      // which Firestore refuses. `byName` falls back on `||` rather than `??`
      // so an account with an empty display name still names somebody.
      await ref.set({
        uid,
        flagged: true,
        reason,
        byUid: actor.uid,
        byName: actor.displayName || "An admin",
        at: FieldValue.serverTimestamp(),
      });
    }

    const saved = await ref.get();
    const flag = normalizeMemberConductFlag(uid, saved.data() ?? {});
    return NextResponse.json(conductFlagForQueue(flag, true));
  } catch (err) {
    console.error("[conduct-flag] write failed:", uid, err);
    return NextResponse.json({ error: "Could not save the conduct flag." }, { status: 500 });
  }
}
