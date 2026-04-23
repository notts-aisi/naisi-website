import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  TASK_EMAIL_CONFIG_PATH,
  readTaskEmailConfig,
} from "@/lib/firestore/taskEmailConfig";

/**
 * Admin-only: read or toggle the task-email kill switch. See
 * `src/lib/firestore/taskEmailConfig.ts` for rationale.
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
  const config = await readTaskEmailConfig(db);
  return NextResponse.json({
    enabled: config.enabled,
    updatedAt: config.updatedAt?.toISOString() ?? null,
    updatedByUid: config.updatedByUid,
  });
}

export async function PATCH(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const enabled = body && typeof body.enabled === "boolean" ? body.enabled : null;
  if (enabled === null) {
    return NextResponse.json(
      { error: "Body must contain { enabled: boolean }" },
      { status: 400 },
    );
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }
  await db
    .collection(TASK_EMAIL_CONFIG_PATH.collection)
    .doc(TASK_EMAIL_CONFIG_PATH.doc)
    .set(
      {
        enabled,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: actor.uid,
      },
      { merge: true },
    );
  return NextResponse.json({ ok: true, enabled });
}
