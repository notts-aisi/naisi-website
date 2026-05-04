import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Admin-only manual override on a single subscription row. Used by the
 * Subscriptions admin tab's per-row "Deactivate" / "Re-activate" buttons
 * and the same controls inside the Members admin tab.
 *
 * Body: { status: "confirmed" | "unsubscribed" | "pending" }
 *
 * Stamps the corresponding timestamp field on transition:
 *  - → "confirmed": sets `confirmedAt`, clears `unsubscribedAt`
 *  - → "unsubscribed": sets `unsubscribedAt`
 *  - → "pending": clears `confirmedAt` and `unsubscribedAt` (admin reset)
 *
 * Re-activation is allowed on the principle that admin override is a
 * trust-the-admin operation — the row's own data plus the audit trail in
 * `emailSends` cover misuse. GDPR mandates honouring an unsubscribe;
 * nothing forbids reversal on explicit user-or-admin ask.
 */

// Inline params shape — see sync-subscriptions/route.ts for the rationale.
type Ctx = { params: Promise<{ id: string }> };

type Body = {
  status?: unknown;
};

const VALID_STATUSES = new Set(["confirmed", "unsubscribed", "pending"]);

export async function POST(req: Request, ctx: Ctx) {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "Missing subscription id" }, { status: 400 });
  }

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const status = typeof parsed.status === "string" ? parsed.status : "";
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${Array.from(VALID_STATUSES).join(", ")}` },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("subscriptions").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  const now = Timestamp.now();
  const patch: Record<string, unknown> = { status };

  if (status === "confirmed") {
    patch.confirmedAt = now;
    // Clear any prior unsubscribed marker so the row reads cleanly. Use
    // FieldValue.delete via a sentinel — admin SDK's Timestamp module
    // exports it through a separate import path, so we just write null
    // here and let the row carry it. Sender + UI both treat
    // unsubscribedAt as "ignore unless status == 'unsubscribed'".
    patch.unsubscribedAt = null;
  } else if (status === "unsubscribed") {
    patch.unsubscribedAt = now;
  } else if (status === "pending") {
    patch.confirmedAt = null;
    patch.unsubscribedAt = null;
  }

  await ref.update(patch);

  return NextResponse.json({ ok: true, id, status });
}
