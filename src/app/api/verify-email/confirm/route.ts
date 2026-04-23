import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { confirmUniEmailVerification } from "@/lib/email/confirmUniEmailVerification";

/**
 * HTTP façade over `confirmUniEmailVerification` for any non-server-component
 * caller (e.g. a direct POST from a client, curl, or test tooling). The
 * `/verify-email/[tokenId]` server component bypasses this route and calls
 * the shared function directly — see that file's comment for why.
 */
export async function POST(req: Request) {
  const { signed } = (await req.json().catch(() => ({}))) as { signed?: string };

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const result = await confirmUniEmailVerification(db, signed);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, email: result.email });
}
