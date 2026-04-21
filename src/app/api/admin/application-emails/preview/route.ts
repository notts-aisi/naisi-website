import { NextResponse } from "next/server";
import { render } from "@react-email/render";
import ApplicationEmail from "@/emails/ApplicationEmail";
import {
  personaliseBlocks,
  personaliseString,
  sanitizeBlocks,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Server-side render of ApplicationEmail for the admin editor's iframe preview.
 * Admin-only (read of unsaved copy). Mirrors /api/newsletter/preview.
 */
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: { subject?: string; blocks?: unknown; tokens?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawSubject = (payload.subject ?? "").toString();
  const blocks = sanitizeBlocks(payload.blocks);
  const tokens = sanitizeTokens(payload.tokens);

  const subject = personaliseString(rawSubject, tokens) || "(no subject)";
  const personalisedBlocks = personaliseBlocks(blocks, tokens);

  try {
    const html = await render(
      ApplicationEmail({
        subject,
        blocks: personalisedBlocks,
        preheader: subject,
      }),
    );
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("[application-email preview]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Render failed" },
      { status: 500 },
    );
  }
}

function sanitizeTokens(raw: unknown): TokenValues {
  if (!raw || typeof raw !== "object") return {};
  const out: TokenValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
