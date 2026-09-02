import { sanitizeBlocks, type Block } from "./newsletterBlocks";
import { isValidDateKey } from "../courses/weekPlan";

/**
 * `coursePages/{courseId}`: the AUTHORED public page for a course.
 *
 * The doc id IS the course id, so a course can never have two pages and no
 * uniqueness query is needed anywhere. There is no `status`: this object is
 * the shop window's copy, and the thing that decides whether the world sees it
 * is `courses.status === "published"`, which the publish route already gates
 * on `approveCourse`.
 *
 * ## ROUTES-ONLY, and why that is not paranoia
 *
 * The rules block is `allow read: if isSignedIn(); allow write: if false`, and
 * every write goes through `PUT /api/courses/[courseId]/page`. The alternative
 * (client-direct authoring with a route beside it, which is how `courses` and
 * `courseRuns` work) was rejected for one specific reason:
 *
 *   `sanitizeBlocks` is a SHAPE FILTER, not an HTML sanitiser. It is
 *   `raw.filter(isValidBlock)`. A `richText` block's `html` is rendered
 *   through `dangerouslySetInnerHTML` (see `features/events/BlockView.tsx`),
 *   and for THIS collection that render happens on a LOGGED-OUT marketing
 *   page. Meanwhile the `courses` update rule admits `isCourseCollaborator()`,
 *   which the rules file itself describes as "possibly a plain member with no
 *   permissions at all".
 *
 * Two write paths cannot enforce one sanitisation. One can. So the route is
 * the only writer, and `sanitizeCoursePageBlocks` below runs at BOTH ends:
 * the route sanitises what it stores, and `normalizeCoursePage` sanitises
 * again at read time (the `normalizeCourse` pattern in `courses.ts`), so a row
 * that reached the collection by any other means (a console edit, a restored
 * backup, a future route written by someone who did not read this comment)
 * is still neutered before it reaches a renderer.
 *
 * ## Deletion
 *
 * The page is COURSE-scoped, not member-scoped: it holds no uid, no member
 * text and no PII. It is therefore counted in the course destroy manifest and
 * deleted by `destroyCourseCascade` (see `courseDeletion.ts`), and it is
 * deliberately NOT part of the per-account deletion sweep in
 * `accountDeletion.ts`. There is nothing of a member's in here to erase, and
 * a sweep keyed on `updatedByUid` would delete a course's public page because
 * the person who last edited it closed their account.
 */

export const COURSE_PAGES_COLLECTION = "coursePages";

/**
 * Field budgets. The route is the security boundary (clients cannot write this
 * collection at all), so these are a cost ceiling on a document with no other
 * one, plus the counters the editor shows.
 */
export const COURSE_PAGE_LIMITS = {
  headline: 200,
  whoItIsFor: 4000,
  howSelectionWorks: 4000,
  membershipExpectation: 2000,
  formatText: 400,
  sessionsText: 400,
  weeklyHoursText: 200,
  themeTitle: 160,
  themeBlurb: 600,
  faqQuestion: 200,
  faqAnswer: 4000,
  journeyLabel: 80,
  journeyDetail: 300,
  coverImageUrl: 500,
  coverAlt: 300,
  visualSeed: 60,
  themesSourceTemplateId: 200,
  themesSourceLabel: 120,
  maxPitchBlocks: 40,
  maxWeeklyThemes: 20,
  maxFaq: 12,
  maxJourney: 8,
  /** Highest week a `sampleWeekNumber` may name. Matches the week-id range. */
  maxWeekNumber: 60,
} as const;

/** One "week 3: Goal misgeneralisation" row on the public themes list. */
export type CoursePageTheme = {
  weekNumber: number;
  title: string;
  /** One or two sentences. Plain text: rendered as a text node, never HTML. */
  blurb: string;
};

export type CoursePageFaq = {
  /** Plain text. */
  q: string;
  /** Plain text. */
  a: string;
};

/**
 * One step of the "how this term goes" strip: applications open, applications
 * close, decisions, first session, last session.
 */
export type CoursePageJourneyStep = {
  label: string;
  detail: string;
  /**
   * Civil "YYYY-MM-DD" (Europe/London), ABSENT when the step has no fixed
   * date. Present so the strip can mark the current step against today's
   * London date key without inventing an instant or a timezone.
   */
  dateKey?: string;
};

export type CoursePageDoc = {
  /** Firestore doc id, and the course id. The two are the same string. */
  id: string;
  /** The big line at the top. Plain text. */
  headline: string;
  /** The pitch. Trusted authored content, sanitised at both ends. */
  pitchBlocks: Block[];
  /** Plain text prose blocks of the facts rail. */
  whoItIsFor: string;
  howSelectionWorks: string;
  membershipExpectation: string;
  formatText: string;
  sessionsText: string;
  weeklyHoursText: string;
  /** The weekly themes list. Generated from a template or a run, then edited. */
  weeklyThemes: CoursePageTheme[];
  /** Which week the "view a sample of the course" section renders. */
  sampleWeekNumber: number | null;
  faq: CoursePageFaq[];
  journey: CoursePageJourneyStep[];
  coverImageUrl: string | null;
  coverAlt: string;
  /**
   * Seed for the generated per-track visual, so a course's artwork is stable
   * across renders instead of re-rolling on every request.
   */
  visualSeed: string;
  /**
   * PROVENANCE for `weeklyThemes`: which snapshot or run they were generated
   * from, and what that source was called at the time.
   *
   * Written ONLY by `POST /api/courses/[courseId]/page/generate-themes`. The
   * PUT route carries the stored values forward untouched, whatever the body
   * says, for the reason `courseRuns.templateId` is server-owned: provenance
   * the editor can also type is not provenance.
   *
   * `themesSourceLabel` is STAFF-FACING. It may name a run, and a run's free
   * text label is exactly the string V3 stopped showing visitors, so it
   * belongs in the authoring UI and never on the public page.
   */
  themesSourceTemplateId: string | null;
  themesSourceLabel: string | null;
  updatedAt?: Date | null;
  updatedByUid?: string | null;
};

/**
 * The page as a STRANGER may see it: the stored document minus the provenance
 * pair.
 *
 * Both dropped keys are staff-facing. `themesSourceLabel` can be a run's free
 * text label, which is the exact string V3 stopped showing visitors and which
 * an author may well have written for themselves ("Autumn 2026 (pilot, do not
 * publish)"); `themesSourceTemplateId` names an internal snapshot. Neither is
 * copy, so neither travels to a public renderer.
 *
 * This is a TYPE, not a convention: `fetchCoursePage` returns it, so a public
 * component cannot render `page.themesSourceLabel` without the compiler saying
 * no first.
 */
export type PublicCoursePage = Omit<
  CoursePageDoc,
  "themesSourceTemplateId" | "themesSourceLabel"
>;

/**
 * Strip the provenance pair. Written as a destructure so a field ADDED to
 * `CoursePageDoc` later is carried through by default: a new key is far more
 * likely to be copy than to be a staff-only field, and the failure mode of the
 * opposite default (an allowlist) is a public page silently missing content an
 * author wrote.
 */
export function toPublicCoursePage(page: CoursePageDoc): PublicCoursePage {
  const {
    themesSourceTemplateId: _templateId,
    themesSourceLabel: _label,
    ...publicFields
  } = page;
  return publicFields;
}

// ---------------------------------------------------------------------------
// HTML neutering for the one dangerouslySetInnerHTML surface
// ---------------------------------------------------------------------------

/**
 * Elements dropped WITH their contents, rather than unwrapped.
 *
 * Unwrapping `<script>alert(1)</script>` would leave `alert(1)` as visible
 * text, which is ugly but harmless; unwrapping `<style>` or `<svg>` leaves
 * fragments that can re-form into markup when the surrounding text is
 * concatenated. Dropping the whole element is both safer and what a reader
 * expects to happen to a script.
 */
const DROP_WITH_CONTENT =
  /<(script|style|title|textarea|noscript|iframe|object|embed|template|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * The tags a pitch block may keep. This is the TipTap output vocabulary plus
 * the handful of things a paste can legitimately bring with it. Anything else
 * is UNWRAPPED (the tag goes, its text stays), so a stray `<div>` costs a
 * wrapper rather than a paragraph of copy.
 */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "hr",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "span",
]);

/** Attributes kept, per tag. Everything else goes, `on*` handlers included. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
};

/** Attribute values that must resolve to an http(s) or mailto target. */
export const SAFE_HREF = /^(https?:|mailto:|\/|#)/i;

/**
 * The two `SAFE_HREF` targets that cannot address an image. A link may point
 * at an inbox or at an anchor on the same page; an `<img src>` that does is
 * either a broken image or a mistyped field.
 */
const NOT_AN_IMAGE_SRC = /^(mailto:|#)/i;

/**
 * Is this a cover image URL we are willing to put in an `src`?
 *
 * `SAFE_HREF` is the allowlist, reused rather than restated so the cover image
 * and a link inside the pitch cannot disagree about what a safe scheme is. The
 * two subtractions narrow it to what the finding asks for, an http(s) URL or a
 * site-relative path:
 *
 *  - `mailto:` and `#`, which are link targets rather than image sources; and
 *  - a PROTOCOL-RELATIVE `//host/x`, which passes the site-relative branch of
 *    `SAFE_HREF` by looking like a path and then loads from another origin.
 *
 * Control characters are stripped before the test for the reason
 * `keptAttributes` strips them: `java\nscript:` is the same URL to a browser,
 * so a check run on the raw string can be walked straight past.
 */
export function isSafeCoverImageUrl(raw: string): boolean {
  const cleaned = raw.replace(/[\u0000-\u0020]/g, "");
  if (!cleaned) return false;
  if (cleaned.startsWith("//")) return false;
  if (NOT_AN_IMAGE_SRC.test(cleaned)) return false;
  return SAFE_HREF.test(cleaned);
}

function escapeAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;

/** Rebuild a tag's attribute list from the allowlist, dropping the rest. */
function keptAttributes(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return "";
  let out = "";
  for (const match of rawAttrs.matchAll(ATTR)) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // `javascript:` and `data:` hrefs are the whole reason this branch reads
    // the value at all. Whitespace and control characters are stripped first
    // because `java\nscript:` is the same URL to a browser.
    const cleaned = value.replace(/[\u0000-\u0020]/g, "");
    if (name === "href" && !SAFE_HREF.test(cleaned)) continue;
    out += ` ${name}="${escapeAttrValue(cleaned)}"`;
  }
  return out;
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

/**
 * Neuter a rich-text block's HTML: an allowlist rewrite, not an escape.
 *
 * ## What this is, and what it is not
 *
 * It is DEFENCE IN DEPTH on the one surface in the courses feature that renders
 * stored HTML to a logged-out visitor. The primary defence is that this
 * collection is `allow write: if false` and only one route writes it. This
 * function is what makes a row that arrives some other way harmless anyway.
 *
 * It is NOT a general-purpose HTML sanitiser and must not be reached for as
 * one. It parses with regular expressions, which is the wrong tool for HTML in
 * the general case; it is adequate HERE because the input it is built for is
 * TipTap's own output, the allowlist is tiny and closed, everything outside it
 * is either dropped or escaped rather than passed through, and it is applied
 * at both the write and the read end so a single miss has to survive twice.
 * If this repo ever gains a real sanitiser dependency, this should call it.
 */
export function neuterRichTextHtml(raw: string): string {
  const stripped = raw.replace(DROP_WITH_CONTENT, "");
  let out = "";
  let cursor = 0;
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(stripped)) !== null) {
    out += escapeAngles(stripped.slice(cursor, match.index));
    cursor = TAG.lastIndex;
    const name = match[1].toLowerCase();
    // Not in the allowlist: UNWRAP. The tag is gone and its text survives,
    // because the alternative (escaping it into visible `<div>` litter) makes
    // a paste from a word processor look broken rather than plain.
    if (!ALLOWED_TAGS.has(name)) continue;
    out += match[0].startsWith("</")
      ? `</${name}>`
      : `<${name}${keptAttributes(name, match[2])}>`;
  }
  out += escapeAngles(stripped.slice(cursor));
  return out;
}

/**
 * `sanitizeBlocks` (the shape filter) PLUS the HTML neutering above, capped.
 *
 * Both halves are needed and neither substitutes for the other: the shape
 * filter drops a block whose `type` is nonsense, and the neutering is the only
 * thing standing between a stored `<script>` and `dangerouslySetInnerHTML`.
 */
export function sanitizeCoursePageBlocks(raw: unknown): Block[] {
  return sanitizeBlocks(raw)
    .slice(0, COURSE_PAGE_LIMITS.maxPitchBlocks)
    .map((block) =>
      block.type === "richText"
        ? { ...block, html: neuterRichTextHtml(block.html) }
        : block,
    );
}

// ---------------------------------------------------------------------------
// Who may author a page
// ---------------------------------------------------------------------------

/** The half of the session the page gate reads. Structural, so this module
 *  stays free of the server-only session import chain. */
export type CoursePageActor = {
  uid: string;
  role: string;
  permissions: { draftCourse?: boolean; approveCourse?: boolean };
};

/** The half of the course doc the page gate reads. */
export type CoursePageCourse = {
  authorUid: string;
  collaboratorUids: string[];
};

/**
 * May this caller write this course's public page?
 *
 * An admin, or a LIVE `draftCourse` / `approveCourse` holder who is either the
 * course's author or one of its named collaborators.
 *
 * NARROWER than the `courses` update rule beside it, which lets any
 * `approveCourse` holder edit any course and lets a bare collaborator with no
 * permission at all edit this one. Both widenings are deliberate there and
 * neither is wanted here: this document is the public marketing copy for a
 * programme, so the writer should hold a live course permission AND have a
 * stated relationship to this particular course. A permission holder with no
 * relationship to the course gets a 403 rather than the run of the catalogue.
 *
 * The permission is re-read from the session on every call, so revoking
 * `draftCourse` takes effect on the next request rather than at the next
 * roster edit.
 */
export function canAuthorCoursePage(
  actor: CoursePageActor,
  course: CoursePageCourse,
): boolean {
  if (actor.role === "admin") return true;
  const holdsPermission = Boolean(
    actor.permissions.draftCourse || actor.permissions.approveCourse,
  );
  if (!holdsPermission) return false;
  return (
    course.authorUid === actor.uid || course.collaboratorUids.includes(actor.uid)
  );
}

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strOrNull(v: unknown, max: number): string | null {
  const value = str(v, max).trim();
  return value ? value : null;
}

export function sanitizeWeeklyThemes(raw: unknown): CoursePageTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CoursePageTheme[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const t = value as Raw;
    if (typeof t.weekNumber !== "number" || !Number.isFinite(t.weekNumber)) continue;
    const weekNumber = Math.floor(t.weekNumber);
    if (weekNumber < 1 || weekNumber > COURSE_PAGE_LIMITS.maxWeekNumber) continue;
    // One row per week. A duplicated week number would render the same week
    // twice and make "week 4 of 8" a lie on a list the visitor counts.
    if (seen.has(weekNumber)) continue;
    seen.add(weekNumber);
    out.push({
      weekNumber,
      title: str(t.title, COURSE_PAGE_LIMITS.themeTitle),
      blurb: str(t.blurb, COURSE_PAGE_LIMITS.themeBlurb),
    });
    if (out.length >= COURSE_PAGE_LIMITS.maxWeeklyThemes) break;
  }
  return out.sort((a, b) => a.weekNumber - b.weekNumber);
}

export function sanitizeFaq(raw: unknown): CoursePageFaq[] {
  if (!Array.isArray(raw)) return [];
  const out: CoursePageFaq[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const f = value as Raw;
    const q = str(f.q, COURSE_PAGE_LIMITS.faqQuestion);
    const a = str(f.a, COURSE_PAGE_LIMITS.faqAnswer);
    // A question with no answer is an unanswered question on a page whose
    // whole job is answering them. Dropped rather than rendered blank.
    if (!q.trim()) continue;
    out.push({ q, a });
    if (out.length >= COURSE_PAGE_LIMITS.maxFaq) break;
  }
  return out;
}

export function sanitizeJourney(raw: unknown): CoursePageJourneyStep[] {
  if (!Array.isArray(raw)) return [];
  const out: CoursePageJourneyStep[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const s = value as Raw;
    const label = str(s.label, COURSE_PAGE_LIMITS.journeyLabel);
    if (!label.trim()) continue;
    const step: CoursePageJourneyStep = {
      label,
      detail: str(s.detail, COURSE_PAGE_LIMITS.journeyDetail),
    };
    // ABSENT, never null: `isValidDateKey` rather than a shape regex, because
    // `2026-02-31` matches the shape and is not a day, and the strip marks the
    // current step by comparing date keys.
    if (typeof s.dateKey === "string" && isValidDateKey(s.dateKey)) {
      step.dateKey = s.dateKey;
    }
    out.push(step);
    if (out.length >= COURSE_PAGE_LIMITS.maxJourney) break;
  }
  return out;
}

/**
 * The stored cover image, or null when it is missing, over its cap, or not a
 * scheme we will put in an `src`.
 *
 * The read end runs the same check as the route for the reason the block
 * neutering does: a row that reached the collection some other way still ends
 * up harmless, rather than harmless only when the route was the writer.
 */
function coverImageUrlOrNull(v: unknown): string | null {
  const value = strOrNull(v, COURSE_PAGE_LIMITS.coverImageUrl);
  if (!value) return null;
  return isSafeCoverImageUrl(value) ? value : null;
}

function asSampleWeekNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 1 || n > COURSE_PAGE_LIMITS.maxWeekNumber) return null;
  return n;
}

/**
 * Read one stored page. `pitchBlocks` goes through
 * `sanitizeCoursePageBlocks` HERE as well as in the route. See the module
 * comment for why the read end is not redundant.
 */
export function normalizeCoursePage(id: string, data: Raw): CoursePageDoc {
  return {
    id,
    headline: str(data.headline, COURSE_PAGE_LIMITS.headline),
    pitchBlocks: sanitizeCoursePageBlocks(data.pitchBlocks),
    whoItIsFor: str(data.whoItIsFor, COURSE_PAGE_LIMITS.whoItIsFor),
    howSelectionWorks: str(data.howSelectionWorks, COURSE_PAGE_LIMITS.howSelectionWorks),
    membershipExpectation: str(
      data.membershipExpectation,
      COURSE_PAGE_LIMITS.membershipExpectation,
    ),
    formatText: str(data.formatText, COURSE_PAGE_LIMITS.formatText),
    sessionsText: str(data.sessionsText, COURSE_PAGE_LIMITS.sessionsText),
    weeklyHoursText: str(data.weeklyHoursText, COURSE_PAGE_LIMITS.weeklyHoursText),
    weeklyThemes: sanitizeWeeklyThemes(data.weeklyThemes),
    sampleWeekNumber: asSampleWeekNumber(data.sampleWeekNumber),
    faq: sanitizeFaq(data.faq),
    journey: sanitizeJourney(data.journey),
    coverImageUrl: coverImageUrlOrNull(data.coverImageUrl),
    coverAlt: str(data.coverAlt, COURSE_PAGE_LIMITS.coverAlt),
    visualSeed: str(data.visualSeed, COURSE_PAGE_LIMITS.visualSeed),
    themesSourceTemplateId: strOrNull(
      data.themesSourceTemplateId,
      COURSE_PAGE_LIMITS.themesSourceTemplateId,
    ),
    themesSourceLabel: strOrNull(
      data.themesSourceLabel,
      COURSE_PAGE_LIMITS.themesSourceLabel,
    ),
    updatedAt: tsToDate(data.updatedAt),
    updatedByUid: (data.updatedByUid as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The theme merge behind POST /page/generate-themes
// ---------------------------------------------------------------------------

/** One week of curriculum, as either source hands it to the generator. */
export type GeneratedThemeSource = {
  weekNumber: number;
  title: string;
  summary: string;
};

export type ThemeMergeResult = {
  weeklyThemes: CoursePageTheme[];
  /** Weeks the source has, left alone because they carried an edited blurb. */
  kept: { weekNumber: number; title: string }[];
  /** Weeks the source does not have at all, kept because the author wrote them. */
  carriedForward: { weekNumber: number; title: string }[];
};

/**
 * Merge a source's weeks into the page's stored themes.
 *
 * Lives here rather than in the route because it is the whole behaviour of
 * that route and it is decidable from three plain arguments, which makes it
 * the part worth pinning with a test.
 *
 * TWO SEPARATE RULES, and it is easy to collapse them into one by accident:
 *
 *  - a week the source HAS, whose stored row already carries a blurb, is kept
 *    when `overwrite` is false. That is the documented default: an author
 *    writes for the visitor, a week summary is written for the cohort, and a
 *    regeneration must not silently swap one for the other.
 *  - a week the source DOES NOT HAVE is kept when `overwrite` is false
 *    whatever its blurb says, because the source has no opinion about it. The
 *    result is a UNION, not a replacement, and without it a regeneration from
 *    a five-week snapshot deletes the theme an author wrote for week 7.
 *
 * `overwrite: true` waives both and makes the source the whole list, which is
 * the only way to shrink it from the generator.
 */
export function mergeGeneratedThemes(args: {
  existing: CoursePageTheme[];
  weeks: GeneratedThemeSource[];
  overwrite: boolean;
}): ThemeMergeResult {
  const { existing, weeks, overwrite } = args;
  const existingByWeek = new Map(existing.map((theme) => [theme.weekNumber, theme]));

  const kept: { weekNumber: number; title: string }[] = [];
  const carriedForward: { weekNumber: number; title: string }[] = [];

  const themes: CoursePageTheme[] = weeks.map((week) => {
    const stored = existingByWeek.get(week.weekNumber);
    // "Edited" means "has a blurb". There is no record of what was generated
    // last time, and inventing one (a hash of the source summary, say) would
    // make a curriculum edit look like an author edit. A non-empty blurb is
    // the honest, checkable version of the question.
    if (!overwrite && stored && stored.blurb.trim()) {
      kept.push({ weekNumber: stored.weekNumber, title: stored.title });
      return stored;
    }
    return {
      weekNumber: week.weekNumber,
      // The title follows the blurb: keeping a hand-written title beside a
      // regenerated blurb reads as a mismatch on the page.
      title: week.title.slice(0, COURSE_PAGE_LIMITS.themeTitle),
      blurb: week.summary.trim().slice(0, COURSE_PAGE_LIMITS.themeBlurb),
    };
  });

  if (!overwrite) {
    const sourceWeeks = new Set(weeks.map((week) => week.weekNumber));
    for (const theme of existing) {
      if (sourceWeeks.has(theme.weekNumber)) continue;
      carriedForward.push({ weekNumber: theme.weekNumber, title: theme.title });
      themes.push(theme);
    }
    // Sorted before sanitising because `sanitizeWeeklyThemes` applies its cap
    // in INPUT order and only then sorts, so an unsorted union over the cap
    // would drop an arbitrary week rather than the highest ones.
    themes.sort((a, b) => a.weekNumber - b.weekNumber);
  }

  return { weeklyThemes: sanitizeWeeklyThemes(themes), kept, carriedForward };
}

/**
 * The empty page, for a course that has never been authored. Returned by the
 * fetcher and the editor so neither has to branch on "no document yet".
 */
export function emptyCoursePage(id: string): CoursePageDoc {
  return normalizeCoursePage(id, {});
}

/**
 * Does this page have enough on it to be worth rendering? The public page
 * falls back to the course's own `summaryBlocks` when it does not.
 *
 * Typed on `PublicCoursePage` so the public renderer, which only ever holds
 * that narrower object, can ask. A full `CoursePageDoc` satisfies it too.
 */
export function coursePageHasContent(page: PublicCoursePage): boolean {
  return (
    page.headline.trim().length > 0
    || page.pitchBlocks.length > 0
    || page.weeklyThemes.length > 0
    || page.whoItIsFor.trim().length > 0
  );
}
