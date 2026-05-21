import "server-only";
import EventRsvpEmail, {
  subjectFor,
  type EventRsvpEmailVariant,
} from "@/emails/EventRsvpEmail";
import { sendEmail } from "@/lib/email/send";
import {
  DIETARY_ALLERGIES,
  FOOD_PROVENANCE_BADGE,
  FOOD_TAG_LABEL,
  sanitizeSignupForm,
  type FoodProvenance,
  type FoodTag,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";
import { buildEventIcs, googleCalendarUrl } from "./ics";
import { getAdminDb } from "@/lib/firebase/admin";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  cancelUrl as buildCancelUrl,
  changeUrl as buildChangeUrl,
  signRsvpToken,
} from "./rsvpToken";

/**
 * Minimal event-shape the email layer needs. Mirrors fields from Firestore;
 * kept loose so callers can pass partially-normalized event data.
 */
type EventLike = {
  id?: string | null;
  title?: string | null;
  location?: string | null;
  locationHidden?: boolean | null;
  locationPublicText?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  foodText?: string | null;
  dietaryTags?: FoodTag[] | null;
  /** @deprecated Legacy food fields, still read as a fallback for old events. */
  foodProvenance?: FoodProvenance | null;
  /** @deprecated See `foodProvenance`. */
  foodProvenanceNote?: string | null;
  /** Raw unknown-typed signup questions (sanitized internally). */
  signupForm?: unknown;
};

function formatWhen(startAt: Date | null | undefined, endAt: Date | null | undefined): string {
  if (!startAt) return "Date to be confirmed";
  const base = startAt.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!endAt) return base;
  const sameDay =
    startAt.getFullYear() === endAt.getFullYear() &&
    startAt.getMonth() === endAt.getMonth() &&
    startAt.getDate() === endAt.getDate();
  if (sameDay) {
    const endTime = endAt.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${base} — ${endTime}`;
  }
  const endFull = endAt.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${base} → ${endFull}`;
}

function locationFor(
  variant: EventRsvpEmailVariant,
  event: EventLike,
): { line: string; disclosure?: string } {
  const exact = (event.location ?? "").trim();
  const fuzzy = (event.locationPublicText ?? "").trim();
  const givesExactLocation = variant === "approved" || variant === "promoted";
  if (givesExactLocation) {
    // Confirmed / promoted attendees always get the real location; if it was
    // hidden on the public page, flag that so they know not to share.
    if (event.locationHidden && exact) {
      return {
        line: exact,
        disclosure:
          "This location was kept off the public event page — please don't share it widely.",
      };
    }
    return { line: exact || "Location to be confirmed" };
  }
  // Requested / waitlisted / denied / cancelled: respect the privacy toggle.
  if (event.locationHidden && fuzzy) {
    return {
      line: `${fuzzy} — exact location shared once your RSVP is approved`,
    };
  }
  return { line: exact || "Location to be confirmed" };
}

function foodLineFor(event: EventLike): string | undefined {
  const text = (event.foodText ?? "").trim();
  const tags = (Array.isArray(event.dietaryTags) ? event.dietaryTags : [])
    .map((t) => FOOD_TAG_LABEL[t as FoodTag])
    .filter(Boolean);
  if (text) {
    return tags.length ? `${text} (${tags.join(", ")})` : text;
  }
  if (tags.length) return tags.join(", ");
  // Legacy fallback for events created before the free-text food field.
  const fp = event.foodProvenance;
  if (!fp || fp === "none") return undefined;
  const badge = FOOD_PROVENANCE_BADGE[fp as Exclude<FoodProvenance, "none">];
  const note = (event.foodProvenanceNote ?? "").trim();
  return note ? `${badge}: ${note}` : badge;
}

type Args = {
  variant: EventRsvpEmailVariant;
  to: string;
  recipientName: string;
  event: EventLike;
  /** Organiser's decision note — only surfaced on the `denied` variant. */
  decisionNote?: string | null;
  /** RSVP doc id — required to include self-service cancel/change links. */
  rsvpId?: string;
  /** Raw answers — used to render the "what you told us" block. */
  answers?: Record<string, RsvpAnswer> | null;
};

function renderAnswerValue(a: RsvpAnswer | undefined): string {
  if (a === undefined || a === null) return "";
  if (typeof a === "string") return a;
  if (typeof a === "boolean") return a ? "Yes" : "No";
  if (Array.isArray(a)) return a.join(", ");
  if (typeof a === "object") {
    const obj = a as { checked?: string[]; other?: string };
    const parts: string[] = [];
    if (Array.isArray(obj.checked) && obj.checked.length > 0) parts.push(...obj.checked);
    if (obj.other) parts.push(`Other: ${obj.other}`);
    return parts.join(", ");
  }
  return "";
}

function buildAnswersLine(
  questions: FormQuestion[],
  answers: Record<string, RsvpAnswer> | null | undefined,
): string {
  if (!answers || Object.keys(answers).length === 0 || questions.length === 0) return "";
  const lines: string[] = [];
  for (const q of questions) {
    const v = renderAnswerValue(answers[q.id]);
    if (!v) continue;
    lines.push(`${q.label}: ${v}`);
  }
  // Surface dietary allergies list for context when nothing was picked.
  if (lines.length === 0) return "";
  void DIETARY_ALLERGIES; // kept in case we later want an "allergies reported" badge
  return lines.join(" · ");
}

/**
 * Fire-and-forget RSVP email. Errors are logged but do not propagate — caller
 * shouldn't fail the user's API request because SMTP hiccuped.
 */
export async function sendRsvpEmail({
  variant,
  to,
  recipientName,
  event,
  decisionNote,
  rsvpId,
  answers,
}: Args): Promise<void> {
  try {
    const db = getAdminDb();
    if (db && (await isSuppressed(db, to))) {
      console.log(`[rsvp email:${variant}] skipped — suppressed:`, to);
      return;
    }
    const title = (event.title ?? "").trim() || "NAISI event";
    const whenLine = formatWhen(event.startAt ?? null, event.endAt ?? null);
    const { line: locationLine, disclosure } = locationFor(variant, event);
    const foodLine = foodLineFor(event);

    // Build self-service links when we have the ids + email for the token.
    let cancelUrl: string | undefined;
    let changeUrl: string | undefined;
    if (event.id && rsvpId) {
      try {
        const token = signRsvpToken(rsvpId, to);
        cancelUrl = buildCancelUrl(event.id, rsvpId, token);
        changeUrl = buildChangeUrl(event.id, rsvpId, token);
      } catch (err) {
        // EVENTS_TOKEN_SECRET missing — log + omit links rather than fail the send.
        console.warn("[rsvp email] skipping self-service links:", err);
      }
    }

    const questions = sanitizeSignupForm(event.signupForm);
    const answersLine = buildAnswersLine(questions, answers);

    // Confirmed / promoted attendees get the event for their calendar: a .ics
    // attachment plus one-tap "add to calendar" links in the body. These
    // variants always disclose the exact location, so the .ics carries it too.
    let attachments:
      | { filename: string; content: string; contentType: string }[]
      | undefined;
    let googleCalUrl: string | undefined;
    let icsUrl: string | undefined;
    if ((variant === "approved" || variant === "promoted") && event.startAt) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const eventUrl = appUrl && event.id ? `${appUrl}/events/${event.id}` : undefined;
      const exactLocation = (event.location ?? "").trim() || undefined;
      const ics = buildEventIcs({
        uid: event.id ?? "event",
        title,
        description: eventUrl,
        location: exactLocation,
        url: eventUrl,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
      });
      attachments = [
        {
          filename: "naisi-event.ics",
          content: ics,
          contentType: "text/calendar; charset=utf-8; method=PUBLISH",
        },
      ];
      googleCalUrl = googleCalendarUrl({
        title,
        description: eventUrl,
        location: exactLocation,
        startAt: event.startAt,
        endAt: event.endAt ?? null,
      });
      if (appUrl && event.id) {
        icsUrl = `${appUrl}/api/events/${event.id}/calendar.ics`;
      }
    }

    await sendEmail({
      to,
      subject: subjectFor(variant, title),
      fromName: "NAISI Events",
      react: EventRsvpEmail({
        variant,
        recipientName: recipientName || "there",
        eventTitle: title,
        whenLine,
        locationLine,
        locationDisclosure: disclosure,
        foodLine,
        decisionNote: decisionNote ?? undefined,
        answersLine: answersLine || undefined,
        googleCalUrl,
        icsUrl,
        cancelUrl,
        changeUrl,
        instagramHandle:
          process.env.NAISI_INSTAGRAM_HANDLE || "notts.ai.safety",
        // Fall back to the monitored Reply-To inbox, never the send-only
        // SMTP_FROM_EMAIL (newsletter@naisi.uk has no receiving MX).
        contactEmail:
          process.env.NAISI_CONTACT_EMAIL ||
          process.env.EMAIL_DEFAULT_REPLY_TO ||
          "ai-safety@uonsu.com",
      }),
      kind: "rsvp",
      referenceId: rsvpId ?? event.id ?? undefined,
      attachments,
    });
  } catch (err) {
    console.error(`[rsvp email:${variant}] send failed`, err);
  }
}
