import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getSessionUid } from "@/lib/firebase/session";
import { sendCollaboratorEmail } from "@/lib/email/collaboratorEmails";
import { markRegistrationProfileComplete } from "@/lib/firestore/registrationWrites";
import { CURRENT_POLICY_VERSION } from "@/lib/legal/policies";
import {
  buildApplication,
  collaboratorDocId,
  validateCollaboratorInput,
  type CollaboratorApplication,
  type CollaboratorInput,
} from "@/lib/firestore/collaborators";

/**
 * Collaborator application write API. ALL collaborator writes go through here
 * (Admin SDK); client writes are locked in firestore.rules. This is the single
 * chokepoint for validation + abuse control.
 *
 *  POST  — create the caller's application (one per account)
 *  PATCH — update the caller's existing application (status stays server-owned)
 *
 * Admin approve/reject/delete live under /api/collaborators/[id]/… (PR 5).
 */

// Per-uid write-spam cooldown on edits. Editing your own (single) application
// can't grow the collection, so this only needs to break a tight rewrite loop,
// not gate a human fixing a second typo — hence a short window. Reuses the
// `updatedAt` the doc already carries (no extra field), mirroring the cooldown
// pattern in /api/subscriptions and /api/verify-email/send.
const EDIT_COOLDOWN_SECONDS = 10;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function readInput(body: Record<string, unknown>): CollaboratorInput {
  const raw = (body.application ?? {}) as Record<string, unknown>;
  const application: CollaboratorApplication = {
    projectPitch: str(raw.projectPitch),
    background: str(raw.background),
    institution: str(raw.institution),
    roleTitle: str(raw.roleTitle),
    interests: str(raw.interests),
    heardAbout: str(raw.heardAbout),
    knowsCommittee: raw.knowsCommittee === true,
    linkedinUrl: str(raw.linkedinUrl) || undefined,
    portfolioUrl: str(raw.portfolioUrl) || undefined,
    committeeContactName: str(raw.committeeContactName) || undefined,
    impactJustification: str(raw.impactJustification) || undefined,
  };
  return { fullName: str(body.fullName), application };
}

export async function POST(req: Request) {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = readInput(body);
  const validationError = validateCollaboratorInput(input);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }
  if (body.agreedToPolicies !== true) {
    return NextResponse.json(
      { error: "You must agree to the Terms of Use and Privacy Policy." },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  // One application per account — also the primary abuse guard (a flood of
  // applications requires a flood of verified accounts). Granular per-IP
  // throttling + App Check is the documented follow-up.
  const existing = await db
    .collection("collaborators")
    .where("uid", "==", session.uid)
    .limit(1)
    .get();
  if (!existing.empty) {
    return NextResponse.json(
      { error: "You've already submitted an application.", id: existing.docs[0].id },
      { status: 409 },
    );
  }

  const application = buildApplication(input);
  const id = collaboratorDocId(input.fullName, session.uid);
  await db
    .collection("collaborators")
    .doc(id)
    .set({
      uid: session.uid,
      email: session.email,
      fullName: input.fullName.trim(),
      status: "pending",
      application,
      policyVersion: CURRENT_POLICY_VERSION,
      policyAgreedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

  // Mirror onto the signup tracker: submitting an application means the signup is
  // complete. Also corrects a Google orphan's default "member" audience, since the
  // tracker row was created at sign-in before any form was chosen. Best-effort.
  await markRegistrationProfileComplete(session.uid, { audience: "collaborator" });

  if (session.email) {
    try {
      await sendCollaboratorEmail({
        kind: "submitted",
        to: session.email,
        name: input.fullName,
        uid: session.uid,
      });
    } catch (e) {
      console.error("[collaborators] submitted email failed", e);
    }
  }

  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: Request) {
  const session = await getSessionUid();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const input = readInput(body);
  const validationError = validateCollaboratorInput(input);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }

  const snap = await db
    .collection("collaborators")
    .where("uid", "==", session.uid)
    .limit(1)
    .get();
  if (snap.empty) {
    return NextResponse.json({ error: "No application found." }, { status: 404 });
  }

  // Write-spam cooldown: reject edits that land within EDIT_COOLDOWN_SECONDS of
  // the last write, reading the doc's existing `updatedAt`.
  const last = snap.docs[0].data().updatedAt as Timestamp | undefined;
  if (last) {
    const elapsedMs = Timestamp.now().toMillis() - last.toMillis();
    if (elapsedMs < EDIT_COOLDOWN_SECONDS * 1000) {
      const wait = Math.ceil((EDIT_COOLDOWN_SECONDS * 1000 - elapsedMs) / 1000);
      return NextResponse.json(
        { error: `You're saving changes too quickly. Please wait ${wait}s and try again.` },
        { status: 429 },
      );
    }
  }

  // Only the editable fields — status, approval, and timestamps stay
  // server-owned and can't be set from here.
  await snap.docs[0].ref.update({
    fullName: input.fullName.trim(),
    application: buildApplication(input),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, id: snap.docs[0].id });
}
