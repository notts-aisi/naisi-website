import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type SerialisedSuppression = {
  id: string;
  email: string;
  reason: string;
  subReason?: string;
  source: string;
  addedAt: string | null;
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
 * Admin-only: list every address in the suppression list for the dashboard.
 * Volumes are naturally small (one row per bounced/complained address), so no
 * pagination needed yet.
 */
export async function GET() {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const snap = await db
    .collection("suppressedEmails")
    .orderBy("addedAt", "desc")
    .get();

  const items: SerialisedSuppression[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      email: (data.email as string | undefined) ?? "",
      reason: (data.reason as string | undefined) ?? "",
      subReason: data.subReason as string | undefined,
      source: (data.source as string | undefined) ?? "",
      addedAt: toIso(data.addedAt),
    };
  });

  return NextResponse.json({ items });
}
