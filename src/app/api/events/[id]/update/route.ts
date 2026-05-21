import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sanitizeBlocks } from "@/lib/firestore/newsletterBlocks";
import {
  FOOD_TAGS,
  asCoverBranding,
  asCoverLogoColor,
  asCoverStripSize,
  sanitizeSignupForm,
} from "@/lib/firestore/events";
import { formatEventWhen, type EventChange } from "@/lib/events/changeSummary";

/**
 * Server-side edit of an event. Firestore rules block client writes once an
 * event is published, so this route is the only path for an organiser to fix
 * details on a live event. Gated to approvers + admins. It also reports which
 * notification-worthy fields changed so the editor can offer to email
 * confirmed attendees.
 */

type Body = Record<string, unknown>;

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveEvent)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ref = db.collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  const old = snap.data() ?? {};

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "The event needs a title." }, { status: 400 });
  }

  const startDate = parseDate(body.startAt);
  if (!startDate) {
    return NextResponse.json(
      { error: "A published event needs a start date and time." },
      { status: 400 },
    );
  }
  const endDate = parseDate(body.endAt);
  if (endDate && endDate.getTime() <= startDate.getTime()) {
    return NextResponse.json(
      { error: "An event can't end before it starts." },
      { status: 400 },
    );
  }

  const location = typeof body.location === "string" ? body.location.trim() : "";
  const locationHidden = body.locationHidden === true;
  const locationPublicText =
    typeof body.locationPublicText === "string" ? body.locationPublicText.trim() : "";
  const visibility = body.visibility === "members" ? "members" : "public";

  const capacityRaw = body.capacity;
  const capacity =
    typeof capacityRaw === "number" && Number.isFinite(capacityRaw) && capacityRaw > 0
      ? Math.floor(capacityRaw)
      : null;
  const waitlistEnabled = capacity === null ? false : body.waitlistEnabled !== false;

  const foodText = typeof body.foodText === "string" ? body.foodText.trim() : "";
  const dietaryTags = Array.isArray(body.dietaryTags)
    ? body.dietaryTags.filter(
        (t): t is string => typeof t === "string" && (FOOD_TAGS as string[]).includes(t),
      )
    : [];
  const posterUrl =
    typeof body.posterUrl === "string" && body.posterUrl ? body.posterUrl : null;

  const patch: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    title,
    blocks: sanitizeBlocks(body.blocks),
    startAt: Timestamp.fromDate(startDate),
    endAt: endDate ? Timestamp.fromDate(endDate) : FieldValue.delete(),
    location,
    locationHidden,
    locationPublicText:
      locationHidden && locationPublicText ? locationPublicText : FieldValue.delete(),
    visibility,
    capacity,
    waitlistEnabled,
    signupForm: sanitizeSignupForm(body.signupForm),
    foodText: foodText ? foodText : FieldValue.delete(),
    dietaryTags,
    posterUrl: posterUrl ?? FieldValue.delete(),
    coverBranding: asCoverBranding(body.coverBranding),
    coverLogoColor: asCoverLogoColor(body.coverLogoColor),
    coverStripSize: asCoverStripSize(body.coverStripSize),
  };

  // Build a human-readable diff of the changes confirmed attendees would want
  // an email about (time and place). The editor uses this to pre-fill the
  // notify composer.
  const oldStart: Date | null = old.startAt?.toDate?.() ?? null;
  const oldEnd: Date | null = old.endAt?.toDate?.() ?? null;
  const oldLocation = typeof old.location === "string" ? old.location : "";

  const timeChanged =
    (oldStart?.getTime() ?? null) !== startDate.getTime() ||
    (oldEnd?.getTime() ?? null) !== (endDate ? endDate.getTime() : null);
  const locationChanged = oldLocation !== location;

  const changeSummary: EventChange[] = [];
  if (timeChanged) {
    changeSummary.push({
      label: "When",
      from: formatEventWhen(oldStart, oldEnd),
      to: formatEventWhen(startDate, endDate),
    });
  }
  if (locationChanged) {
    changeSummary.push({
      label: "Where",
      from: oldLocation || "(not set)",
      to: location || "(not set)",
    });
  }

  await ref.update(patch);

  return NextResponse.json({ ok: true, changeSummary });
}
