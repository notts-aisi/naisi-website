import "server-only";
import AdmissionsAppointedEmail from "@/emails/AdmissionsAppointedEmail";
import AdmissionsDeadlineReminderEmail from "@/emails/AdmissionsDeadlineReminderEmail";
import AdmissionsReinstatedEmail from "@/emails/AdmissionsReinstatedEmail";
import AdmissionsDeclinedEmail from "@/emails/AdmissionsDeclinedEmail";
import AdmissionsStageReleasedEmail from "@/emails/AdmissionsStageReleasedEmail";
import AdmissionsSubmittedEmail from "@/emails/AdmissionsSubmittedEmail";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  buildCourseTokens,
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  personaliseBlocks,
  personaliseString,
  type Block,
  type TokenValues,
} from "@/lib/firestore/newsletterBlocks";
import { sendEmail } from "./send";

/**
 * ADMISSIONS lifecycle mail: the applicant's own receipts on an admission
 * round, the weekly-questions announcement, and the appointment round's two
 * decisions. Six sends today, one per template id, and the rest of the
 * round's lifecycle (the enrolment decisions) lands on this module as those
 * routes are built.
 *
 * Four of the six are fired by somebody's own action, the applicant's or the
 * decider's, and two, the deadline reminder and the stage announcement, are
 * fired by the scheduler tick.
 * That difference is why this function returns an outcome (see
 * `AdmissionSendOutcome`): a claimed marker has to know whether the send
 * actually happened.
 *
 * ## Why it is not `courseApplicationEmails.ts`
 *
 * That module's whole contract is stated in terms of a RUN: its options are
 * `courseTitle` / `runLabel` / `startDate`, it logs as `course-application`,
 * and its comment is a set of promises about what a decision email may claim
 * about a group and a first session. An admission round has none of those. One
 * round feeds several runs and an appointment round feeds none, so folding
 * these in would have made every one of those sentences conditionally true and
 * left `{courseTitle}` resolving to something arbitrary in an applicant's
 * inbox.
 *
 * ## Template resolution is FALLBACK-FIRST
 *
 * A stored `courseEmailTemplates/{id}` doc wins only when it is well-formed and
 * non-empty, so an admin who saves a blank body still sends the seed copy, and
 * a Firestore read failure degrades to the defaults rather than to silence.
 * Same discipline as both sibling modules, and it matters more here: there is
 * no seed step, so "no doc" is the normal state on a fresh backend.
 *
 * ## Suppression is checked here, and this function never throws
 *
 * `sendEmail` logs a send; it does not consult the suppression list, and
 * continuing to mail a hard bounce is how a sending domain's reputation goes.
 * A suppressed address is skipped silently.
 *
 * Every call site fires this AFTER its transaction has committed, and a
 * confirmation is a courtesy rather than part of the write, so the whole body
 * sits in a try/catch and the caller cannot tell a send from a skip from a
 * failure. That is the `sendRsvpEmail` posture, chosen for the same reason: an
 * SMTP hiccup must never turn a saved application into a 500 the applicant
 * reads as "it did not go through".
 */

/**
 * `declined` is the APPOINTMENT round's refusal: we cannot take you on as a
 * facilitator. The ENROLMENT round's refusal is a different send about a
 * different thing (a place on a course rather than a role running one) and it
 * arrives with the enrolment decide path under its own kind and its own
 * template id. Naming this one `rejected` would have taken that id.
 */
export type AdmissionEmailKind =
  | "submitted"
  | "reinstated"
  | "deadline-reminder"
  | "stage-released"
  | "appointed"
  | "declined";

export const TEMPLATE_FOR_KIND: Record<AdmissionEmailKind, CourseTemplateId> = {
  submitted: "admissions-submitted",
  reinstated: "admissions-reinstated",
  "deadline-reminder": "admissions-deadline-reminder",
  "stage-released": "admissions-stage-released",
  appointed: "admissions-appointed",
  declined: "admissions-declined",
};

/**
 * What one send DID, for the one caller that has to know.
 *
 * The applicant-lane call sites and the decide route fire this and walk away:
 * a receipt is a courtesy, and so is the letter about a decision the commit
 * already recorded, so `void sendAdmissionEmail(...)` is the right shape in
 * both places. The SCHEDULER cannot walk away. It holds a marker it claimed
 * before the send, and stamping `sentAt` on a send that threw would be
 * permanent silent non-delivery: every later tick would re-derive the same
 * reminder, find a stamped marker, and skip. So the outcome comes back, and
 * the tick stamps `sentAt` only on `sent`, leaves the marker unstamped on
 * `failed` (which is what the re-claim rule exists to pick up), and settles it
 * as skipped on `suppressed`.
 *
 * Returning a value costs the fire-and-forget callers nothing: `void` on a
 * promise that resolves to a string is the same statement it always was.
 */
export type AdmissionSendOutcome = "sent" | "suppressed" | "failed";

/**
 * The tokens each TRIGGER actually supplies, and the list is per kind rather
 * than per helper on purpose.
 *
 * `AdmissionEmailOptions` describes what this function CAN be passed; a call
 * site decides what it DOES pass, and the two are not the same list. The
 * reinstate branch of `POST .../apply` sends no `decisionsBy` and no
 * `stageLabel`, so seed copy or an admin's rewrite using `{decisionsBy}` would
 * arrive as those nine literal characters in somebody's inbox, and a test that
 * asked the helper what it supports would have called that fine.
 *
 * So the map is the contract, the filter below enforces it, and
 * `tests/admissions-status-hub.test.mjs` checks each template's copy against
 * its own kind's set. A trigger that starts supplying a token adds it here in
 * the same commit as the call site.
 *
 * The three COURSE tokens are absent from every entry but `appointed`, which
 * is what drops them: a round is not a run, so `{courseTitle}` stays literal
 * rather than resolving to a blank and cutting a hole in a sentence. They ARE
 * present on `appointed`, and that is not an inconsistency: an appointment
 * names a run, because it writes the person onto one. It is the one admissions
 * send that knows a course.
 *
 * `appointed` may therefore resolve all three to whatever the run says, blank
 * included, and nothing here re-checks that. The decide route is where an
 * appointment onto a run with no start date is refused, so by the time this
 * function is called the date exists. A second guard here would have been a
 * filter quietly rescuing a decision the route should not have let through.
 *
 * `declined` carries NO `reason` token, and its absence is the point.
 * `AdmissionsDeclinedEmail` renders the decider's shared note as its own
 * paragraph, so a `{reason}` in the body would print the same sentence a
 * second time. The share gate lives on the prop; the token set does not
 * duplicate it.
 */
export const TOKENS_BY_KIND: Record<AdmissionEmailKind, readonly string[]> = {
  submitted: [
    "preferredName",
    "firstName",
    "roundLabel",
    "applicationUrl",
    "deadline",
    "decisionsBy",
    "stageLabel",
  ],
  reinstated: ["preferredName", "firstName", "roundLabel", "applicationUrl", "deadline"],
  // The tick knows the round and its deadline and nothing else: no stage is
  // involved in a draft reminder, and the decisions-by date is a promise the
  // submitted receipt makes, not this one.
  "deadline-reminder": [
    "preferredName",
    "firstName",
    "roundLabel",
    "applicationUrl",
    "deadline",
  ],
  // The stage announcement knows the round, the part of the form that has
  // just opened, and the deadline that part is due by (the earlier of the
  // stage's own and the round's). It knows nothing about a decision, so no
  // `decisionsBy`.
  "stage-released": [
    "preferredName",
    "firstName",
    "roundLabel",
    "stageLabel",
    "applicationUrl",
    "deadline",
  ],
  appointed: [
    "preferredName",
    "firstName",
    "roundLabel",
    "applicationUrl",
    "courseTitle",
    "runLabel",
    "startDate",
  ],
  declined: [
    "preferredName",
    "firstName",
    "roundLabel",
    "applicationUrl",
    "decisionsBy",
  ],
};

export type AdmissionEmailOptions = {
  kind: AdmissionEmailKind;
  /** Deliverable address, from the SESSION at the call site, never a body field. */
  to: string;
  /** Display name; drives the {preferredName} / {firstName} tokens. */
  name: string;
  /** The round's public label, for {roundLabel}. */
  roundLabel: string;
  /**
   * Where this applicant reads this application: the form while it is still
   * theirs to finish, `/applications/[roundId]` once it has been sent. Absolute,
   * built from `NEXT_PUBLIC_APP_URL` by `admissionApplicationUrl` below.
   */
  applicationUrl: string;
  /** Human-formatted deadline ("Sun 18 Oct, 23:59"). Omitted when the round has none. */
  deadline?: string;
  /** Human-formatted decisions-by date ("Fri 23 Oct"). Omitted when unset. */
  decisionsBy?: string;
  /**
   * The part of a multi-part form this send is about. Omitted on a
   * single-stage round, where naming "the form" as a stage would be noise.
   */
  stageLabel?: string;
  /**
   * THE APPOINTMENT TRIO. Only the `appointed` kind supplies these, because
   * only an appointment has written the person onto a run. Everything else
   * leaves them out and the filter drops them.
   */
  courseTitle?: string;
  runLabel?: string;
  /** Human-formatted run start ("Monday 26 October"). */
  startDate?: string;
  /**
   * The decider's note, rendered by `AdmissionsAppointedEmail` as its own
   * paragraph. MEMBER-AUTHORED PLAIN TEXT: it never reaches the token map and
   * never reaches a `richText` block, so it cannot land in
   * `dangerouslySetInnerHTML`. `appointed` only.
   */
  note?: string;
  /**
   * The decider's reason, and ONLY when they ticked "share this". Passed to
   * `AdmissionsDeclinedEmail` as a PROP and as nothing else: the component
   * owns the paragraph, so there is no matching token and no way for one note
   * to be printed twice. `declined` only.
   */
  sharedReason?: string;
  /** The applicant's uid, the deliverability log's actor. */
  uid: string;
  /** The round id, the log's reference, so one intake's mail is greppable. */
  roundId: string;
};

/** The absolute url for a round's application, for whichever surface owns it. */
export function admissionApplicationUrl(
  roundId: string,
  surface: "apply" | "status",
): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (!base) return "";
  const path = surface === "apply" ? "apply" : "applications";
  return `${base}/${path}/${encodeURIComponent(roundId)}`;
}

/**
 * One kind, one component, chosen exhaustively.
 *
 * A `switch` over the union rather than a chain of ternaries, so adding a kind
 * without a component is a TYPE ERROR here instead of a silently
 * wrong-looking email: `renderFor` has no default arm and TypeScript checks
 * that every member returns.
 *
 * The two member-authored strings (`note` on an appointment, `sharedReason` on
 * a refusal) are handed to their component as PROPS. They are deliberately not
 * in `personalisedBlocks`: those blocks reach `dangerouslySetInnerHTML`.
 */
function renderFor(
  opts: AdmissionEmailOptions,
  subject: string,
  blocks: Block[],
) {
  switch (opts.kind) {
    case "submitted":
      return AdmissionsSubmittedEmail({
        subject,
        blocks,
        applicationUrl: opts.applicationUrl,
        preheader: subject,
      });
    case "reinstated":
      return AdmissionsReinstatedEmail({
        subject,
        blocks,
        applicationUrl: opts.applicationUrl,
        preheader: subject,
      });
    case "deadline-reminder":
      return AdmissionsDeadlineReminderEmail({
        subject,
        blocks,
        applicationUrl: opts.applicationUrl,
        preheader: subject,
      });
    case "stage-released":
      return AdmissionsStageReleasedEmail({
        subject,
        blocks,
        applicationUrl: opts.applicationUrl,
        preheader: subject,
      });
    case "appointed":
      return AdmissionsAppointedEmail({
        subject,
        blocks,
        note: opts.note ?? "",
        applicationUrl: opts.applicationUrl,
        preheader: subject,
      });
    case "declined":
      return AdmissionsDeclinedEmail({
        subject,
        blocks,
        sharedReason: opts.sharedReason ?? "",
        preheader: subject,
      });
  }
}

const TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/**
 * Drop a block whose sentence depends entirely on a token this trigger
 * SUPPLIES and this send had no value for.
 *
 * The house convention is that an unresolved token stays literal, so an admin
 * who typed `{courseTitle}` into an application receipt sees it and fixes it.
 * That convention is right for a token the trigger never supplies, and wrong
 * for one it supplies conditionally: a round with no `closesAt` (a legitimate
 * shape, meaning "no automatic deadline") would otherwise mail an applicant
 * the literal characters "it is due by {deadline}." Nobody typed a mistake
 * there; the data simply is not there.
 *
 * So the rule is exact rather than a heuristic, and it is the same one the
 * weekly nudge uses. A block is dropped only when it references at least one
 * SUPPLIED token and every supplied token it references came back with no
 * value. A block that resolved anything is kept whole, and a token outside
 * this trigger's set is not considered at all, so it still stays visible.
 *
 * The copy rule that falls out of it, and the seed copy obeys it: KEEP A
 * CONDITIONAL TOKEN IN A BLOCK OF ITS OWN. A deadline folded into a paragraph
 * that says other things takes those other things with it.
 */
export function dropDataAbsentBlocks(
  blocks: Block[],
  kind: AdmissionEmailKind,
  tokens: TokenValues,
): Block[] {
  const supplied = new Set<string>(TOKENS_BY_KIND[kind]);
  const missing = new Set(
    [...supplied].filter((token) => tokens[token] === undefined),
  );
  if (missing.size === 0) return blocks;
  return blocks.filter((block) => {
    const text =
      block.type === "heading"
        ? block.text
        : block.type === "richText"
          ? block.html
          : null;
    if (text === null) return true;
    const referenced = [...text.matchAll(TOKEN_PATTERN)]
      .map((match) => match[1])
      .filter((token) => supplied.has(token));
    if (referenced.length === 0) return true;
    return !referenced.every((token) => missing.has(token));
  });
}

export async function sendAdmissionEmail(
  opts: AdmissionEmailOptions,
): Promise<AdmissionSendOutcome> {
  try {
    const templateId = TEMPLATE_FOR_KIND[opts.kind];
    const defaults = courseTemplateDefaults[templateId];

    let subject = defaults.subject;
    let blocks = defaults.blocks;
    let fromName: string | undefined;

    const db = getAdminDb();
    if (db) {
      if (await isSuppressed(db, opts.to)) {
        console.log(`[admissions email:${opts.kind}] skipped, suppressed:`, opts.to);
        return "suppressed";
      }
      try {
        const snap = await db.collection("courseEmailTemplates").doc(templateId).get();
        if (snap.exists) {
          const template = normalizeCourseTemplate(snap.id, snap.data() ?? {});
          if (template && template.subject && template.blocks.length > 0) {
            subject = template.subject;
            blocks = template.blocks;
            fromName = template.fromName;
          }
        }
      } catch (err) {
        console.warn("[admissions email] template read failed", templateId, err);
      }
    }

    const built = buildCourseTokens({
      // `name` is already the resolved preferredName / displayName fallback
      // at the call site, so it feeds the builder as the display name.
      user: { displayName: opts.name },
      // A round is not a run, so these three are empty on every kind EXCEPT
      // `appointed`, which has just written the recipient onto one. Where they
      // are empty the filter below drops them, so a course token pasted into
      // an application receipt stays literal instead of resolving to a blank.
      courseTitle: opts.courseTitle ?? "",
      runLabel: opts.runLabel ?? "",
      startDate: opts.startDate ?? "",
      applicationUrl: opts.applicationUrl,
      roundLabel: opts.roundLabel,
      stageLabel: opts.stageLabel,
      deadline: opts.deadline,
      decisionsBy: opts.decisionsBy,
      // NO `reason`. The shared note reaches the refusal as a component prop,
      // and a token as well would put the same paragraph in twice. See
      // `CourseTokenMap.reason`.
    });
    // THE FILTER, by kind: anything this trigger does not supply is dropped
    // rather than resolved, so an unsupplied token stays visible as `{token}`
    // to whoever wrote the copy instead of blanking mid-sentence.
    const allowed = new Set<string>(TOKENS_BY_KIND[opts.kind]);
    const tokens: TokenValues = {};
    for (const [key, value] of Object.entries(built)) {
      if (!allowed.has(key)) continue;
      tokens[key] = value;
    }

    const personalisedSubject = personaliseString(subject, tokens);
    const personalisedBlocks = personaliseBlocks(
      dropDataAbsentBlocks(blocks, opts.kind, tokens),
      tokens,
    );

    const react = renderFor(opts, personalisedSubject, personalisedBlocks);

    await sendEmail({
      to: opts.to,
      subject: personalisedSubject,
      react,
      fromName,
      kind: "admissions",
      actorUid: opts.uid,
      referenceId: opts.roundId,
    });
    return "sent";
  } catch (err) {
    console.error(`[admissions email:${opts.kind}] send failed`, opts.roundId, err);
    return "failed";
  }
}
