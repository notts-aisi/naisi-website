import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type SerialisedSend = {
  id: string;
  to: string;
  subject: string;
  kind: string;
  status: string;
  statusReason?: string;
  sentAt: string | null;
  statusUpdatedAt: string | null;
  actorUid?: string;
  referenceId?: string;
};

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (v instanceof Date) return v.toISOString();
  return null;
}

/**
 * Admin-only: list the most recent emailSends rows for the deliverability
 * dashboard. Defaults to last 50; a `?limit=` query param can adjust up to 200.
 */
export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const parsed = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;

  const snap = await db
    .collection("emailSends")
    .orderBy("sentAt", "desc")
    .limit(limit)
    .get();

  const items: SerialisedSend[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      to: (data.to as string | undefined) ?? "",
      subject: (data.subject as string | undefined) ?? "",
      kind: (data.kind as string | undefined) ?? "unknown",
      status: (data.status as string | undefined) ?? "sent",
      statusReason: data.statusReason as string | undefined,
      sentAt: toIso(data.sentAt),
      statusUpdatedAt: toIso(data.statusUpdatedAt),
      actorUid: data.actorUid as string | undefined,
      referenceId: data.referenceId as string | undefined,
    };
  });

  return NextResponse.json({ items });
}
