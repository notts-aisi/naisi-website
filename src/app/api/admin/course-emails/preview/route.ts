import { NextResponse } from "next/server";
import { render } from "@react-email/render";
import ApplicationEmail from "@/emails/ApplicationEmail";
import CourseNudgeEmail from "@/emails/CourseNudgeEmail";
import {
  courseNudgeTokensFrom,
  renderCourseNudge,
  COURSE_NUDGE_TEMPLATE_ID,
} from "@/lib/email/courseNudgeEmail";
import { getCurrentUser } from "@/lib/firebase/session";
import { isCourseTemplateId } from "@/lib/firestore/courseEmails";
import {
  personaliseBlocks,
  personaliseString,
  sanitizeBlocks,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";

/**
 * Server-side render of a COURSE email for the admin editor's iframe preview.
 *
 * Five of the six course templates render exactly as the application-email
 * preview does — same `ApplicationEmail` chrome, same `personaliseBlocks`, same
 * "an unresolved token stays literal so an admin notices" convention — which is
 * why the course editor used that endpoint verbatim until now.
 *
 * THE WEEKLY NUDGE IS THE EXCEPTION, and it is the whole reason this route
 * exists. It renders through different chrome (`CourseNudgeEmail`, which carries
 * the visible unsubscribe line), and its tokens go through `renderCourseNudge`,
 * which escapes per destination context and DELETES a sentence whose tokens all
 * resolved empty instead of leaving its scaffolding behind. Previewing it
 * through the generic path showed an admin a message no recipient would ever
 * receive — no unsubscribe footer, and a rendering that could not demonstrate
 * the one rule the editor's own help text promises.
 *
 * Admin-only (it renders unsaved copy). Mirrors
 * `/api/admin/application-emails/preview`.
 */
export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: {
    subject?: string;
    blocks?: unknown;
    tokens?: unknown;
    templateId?: unknown;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawSubject = (payload.subject ?? "").toString();
  const blocks = sanitizeBlocks(payload.blocks);
  const tokens = sanitizeTokens(payload.tokens);
  const templateId =
    typeof payload.templateId === "string" && isCourseTemplateId(payload.templateId)
      ? payload.templateId
      : null;

  try {
    const html =
      templateId === COURSE_NUDGE_TEMPLATE_ID
        ? await renderNudgePreview(rawSubject, blocks, tokens)
        : await renderCourseTemplatePreview(rawSubject, blocks, tokens);
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("[course-email preview]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Render failed" },
      { status: 500 },
    );
  }
}

/** The five lifecycle templates — unchanged from the application-email path. */
function renderCourseTemplatePreview(
  rawSubject: string,
  blocks: ReturnType<typeof sanitizeBlocks>,
  tokens: TokenValues,
): Promise<string> {
  const subject = personaliseString(rawSubject, tokens) || "(no subject)";
  return render(
    ApplicationEmail({
      subject,
      blocks: personaliseBlocks(blocks, tokens),
      preheader: subject,
    }),
  );
}

/**
 * The nudge, through the one implementation a recipient gets.
 *
 * The unsubscribe link is a SAMPLE. A real one is a signed token scoped to one
 * member and one run's cohort channel, and a designer preview has neither — so
 * the footer shows the copy and the shape without minting anything that could
 * flip a subscription row. The preview iframe is sandboxed without
 * `allow-top-navigation`, so it is inert there regardless.
 */
function renderNudgePreview(
  rawSubject: string,
  blocks: ReturnType<typeof sanitizeBlocks>,
  tokens: TokenValues,
): Promise<string> {
  const rendered = renderCourseNudge(
    { subject: rawSubject, blocks },
    courseNudgeTokensFrom(tokens),
  );
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return render(
    CourseNudgeEmail({
      subject: rendered.subject,
      blocks: rendered.blocks,
      unsubscribeUrl: `${appUrl}/api/unsubscribe?t=sample-preview-token`,
      preheader: rendered.preheader || rendered.subject,
    }),
  );
}

function sanitizeTokens(raw: unknown): TokenValues {
  if (!raw || typeof raw !== "object") return {};
  const out: TokenValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
