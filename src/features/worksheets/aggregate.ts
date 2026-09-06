/**
 * What a circulation's answers ADD UP TO: the bar chart staff read, the bar
 * chart a poll shows its own respondents, and the table the CSV export writes.
 *
 * Pure by construction. Nothing here touches React, Firestore, the DOM or a
 * clock, and every function takes what it needs as an argument. That is not
 * tidiness: these are the rules about what a number in front of somebody
 * MEANS. "3 of 8 chose this" is a claim about a denominator, and the
 * denominator is a decision (everyone sent it? everyone who answered? everyone
 * who submitted?). A decision of that kind belongs somewhere it can be read on
 * its own and asserted against, which is `tests/worksheet-aggregate.test.mjs`.
 *
 * ── THE DENOMINATOR, ONCE ───────────────────────────────────────────────────
 * Every percentage in this file is a share of the people who ANSWERED THAT
 * QUESTION, never of the people the worksheet was sent to. Two reasons, and
 * the second is the one that decided it:
 *   1. an optional question answered by three of thirty is not "10% said yes",
 *      it is "of the three who answered, all three said yes", and the first
 *      reading is the one a sender would act on wrongly;
 *   2. the caller can always show the other number too, because `respondents`
 *      travels beside the percentages. A percentage that hid its denominator
 *      would leave them nothing to show.
 * A multiple-choice question's percentages therefore sum to more than 100, and
 * the view says "of N respondents" out loud rather than pretending otherwise.
 *
 * ── A REMOVED OPTION IS COUNTED, NOT DROPPED ────────────────────────────────
 * Answers store option IDS (see `worksheets.ts`), so an author who deletes an
 * option mid-flight leaves answers pointing at nothing. Those answers are
 * gathered into ONE synthetic bucket labelled "(option removed)" rather than
 * discarded: silently dropping them would make the counts disagree with
 * `respondents` and read as "those people did not answer", which is a
 * different and worse claim than "the thing they chose is gone".
 */
import {
  RESPONSE_STATE_LABELS,
  type CirculationDoc,
  type ResponseDoc,
} from "@/lib/firestore/circulations";
import {
  answerIsEmpty,
  questionsOf,
  ratingScaleOf,
  type WorksheetAnswer,
  type WorksheetQuestion,
} from "@/lib/firestore/worksheets";

/**
 * The label for answers whose option no longer exists.
 *
 * `AnswerSummary.tsx` carries the same string for one recipient's single
 * answer, and the two must read identically: staff who see "(option removed)"
 * beside somebody's name and then a bar of the same name are looking at the
 * same fact, and two spellings of it would read as two different things. If
 * this one changes, change that one.
 */
export const REMOVED_OPTION_LABEL = "(option removed)";

/**
 * The label for an option that EXISTS and has no words in it.
 *
 * A different sentence from the one above, and the difference is the whole
 * point. `newOption()` creates an option with an empty label and nothing
 * refuses one at circulate time, so a blank label is a live choice somebody
 * can still tick. Printing "(option removed)" over it would tell a sender
 * three people chose something they had deleted, which is a claim about their
 * own editing rather than about the answers, and they would go looking for an
 * edit they never made.
 */
export const UNTITLED_OPTION_LABEL = "(untitled option)";

/**
 * The id of that synthetic bucket. Prefixed with two underscores because
 * `newItemId` never produces one (its ids are `o_<base36>_<random>`), so it
 * cannot collide with a real option id however many are added.
 */
export const REMOVED_OPTION_ID = "__removed";

/** The name shown for a uid with no user document. Mirrors `MEMBER_NAME_FALLBACK`
 *  in `MemberName.tsx` and `displayNameOf` in the routes; never an email. */
export const UNKNOWN_MEMBER_NAME = "NAISI member";

/**
 * What a question with no title is called: the CSV column header, and the
 * heading on its card in the staff aggregate view. One constant rather than
 * one string per surface, for the reason `REMOVED_OPTION_LABEL` gives above.
 */
export const UNTITLED_QUESTION_HEADER = "Untitled question";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One person's answer to one question. The uid rides along because the text
 *  and image aggregates are lists of who said what, not counts. */
export type RespondentAnswer = { uid: string; answer: WorksheetAnswer | undefined };

export type OptionTally = {
  optionId: string;
  label: string;
  count: number;
  /** Whole percent of `respondents`. Rounded, so a set of bars can sum to 99. */
  percent: number;
  /** True only for the synthetic "(option removed)" bucket. */
  removed: boolean;
};

export type RatingBand = { value: number; count: number; percent: number };

export type TextAnswer = { uid: string; text: string };

export type ImageAnswerRow = { uid: string; images: { url: string; storagePath: string }[] };

/**
 * A discriminated union rather than one wide shape with optional fields: the
 * view renders a different thing per arm, and an optional `mean` on a choice
 * question is a field somebody eventually reads and prints as "NaN".
 */
export type QuestionAggregate =
  | { kind: "options"; respondents: number; options: OptionTally[] }
  | {
      kind: "rating";
      respondents: number;
      scale: number;
      bands: RatingBand[];
      /** Null over an empty set. Never 0: nobody rated this 0. */
      mean: number | null;
    }
  | { kind: "text"; respondents: number; texts: TextAnswer[] }
  | { kind: "images"; respondents: number; rows: ImageAnswerRow[] };

/** Counts keyed by the option id as STORED, removed ids included. The wire
 *  shape of the aggregate route, and the input to `tallyOptions`. */
export type OptionCounts = Record<string, number>;

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

function percentOf(count: number, respondents: number): number {
  if (respondents <= 0) return 0;
  return Math.round((count / respondents) * 100);
}

/**
 * Turn raw per-option-id counts into the bars a view draws.
 *
 * SEPARATE FROM `aggregateQuestion` because it has two callers that arrive by
 * different roads. Staff hold every response document and count them here; a
 * recipient holds only their own and is handed counts by
 * `GET /api/worksheets/circulations/{id}/aggregate`, which is the only path by
 * which they learn anything about anybody else. Both then need the same order,
 * the same removed bucket and the same rounding, and computing that twice is
 * how the poll a recipient sees comes to disagree with the poll staff see.
 *
 * The order is the AUTHOR'S order, never sorted by count. A bar chart that
 * re-orders itself as votes arrive is one nobody can read twice, and the
 * options are already in the order the question asked them in.
 */
export function tallyOptions(
  question: Pick<WorksheetQuestion, "options">,
  counts: OptionCounts,
  respondents: number,
): OptionTally[] {
  const options = question.options ?? [];
  const known = new Set(options.map((option) => option.id));
  const tallies: OptionTally[] = options.map((option) => {
    const count = counts[option.id] ?? 0;
    return {
      optionId: option.id,
      // The option is RIGHT HERE in the question, so a blank label is an
      // untitled option and never a removed one: see `UNTITLED_OPTION_LABEL`.
      label: option.label.trim() || UNTITLED_OPTION_LABEL,
      count,
      percent: percentOf(count, respondents),
      removed: false,
    };
  });

  let orphaned = 0;
  for (const [optionId, count] of Object.entries(counts)) {
    if (!known.has(optionId)) orphaned += count;
  }
  // Only when there is something in it. An empty "(option removed)" row on
  // every question would read as a warning about a worksheet nobody has edited.
  if (orphaned > 0) {
    tallies.push({
      optionId: REMOVED_OPTION_ID,
      label: REMOVED_OPTION_LABEL,
      count: orphaned,
      percent: percentOf(orphaned, respondents),
      removed: true,
    });
  }
  return tallies;
}

/**
 * Raw counts per stored option id, plus how many people answered at all.
 *
 * Exported because the aggregate route returns exactly this over the wire: it
 * hands a recipient counts and a total and nothing else, and building that
 * from the same function the staff view uses is what keeps the two views
 * telling one story.
 */
export function countOptions(answers: RespondentAnswer[]): {
  counts: OptionCounts;
  respondents: number;
} {
  const counts: OptionCounts = {};
  let respondents = 0;
  for (const { answer } of answers) {
    if (!answer || answerIsEmpty(answer)) continue;
    if (answer.type === "choice") {
      respondents += 1;
      counts[answer.optionId] = (counts[answer.optionId] ?? 0) + 1;
      continue;
    }
    if (answer.type === "choices") {
      respondents += 1;
      // De-duplicated: `validateAnswer` refuses a repeated id at submit, but an
      // in-progress answer is not validated, and one person must not be able to
      // count twice for one option by holding a malformed draft.
      const seen = new Set<string>();
      for (const optionId of answer.optionIds) {
        if (seen.has(optionId)) continue;
        seen.add(optionId);
        counts[optionId] = (counts[optionId] ?? 0) + 1;
      }
    }
  }
  return { counts, respondents };
}

/**
 * Everything one question's answers add up to, in the shape its type needs.
 *
 * An answer of the WRONG shape for the question (a text answer stored against
 * a rating, say, which only a hand-edited document produces) is ignored rather
 * than counted or thrown on: this is a read path with nobody to ask, and the
 * alternative to ignoring it is a page that will not render at all.
 */
export function aggregateQuestion(
  question: WorksheetQuestion,
  answers: RespondentAnswer[],
): QuestionAggregate {
  switch (question.type) {
    case "singleChoice":
    case "multipleChoice":
    case "poll": {
      const { counts, respondents } = countOptions(answers);
      return { kind: "options", respondents, options: tallyOptions(question, counts, respondents) };
    }

    case "rating": {
      const scale = ratingScaleOf(question);
      const byValue = new Map<number, number>();
      let total = 0;
      let respondents = 0;
      for (const { answer } of answers) {
        if (!answer || answer.type !== "rating" || answerIsEmpty(answer)) continue;
        // Out of the question's band: a scale an author SHRANK mid-flight
        // leaves ratings above the new top. They still count towards the mean
        // (somebody gave them) but have no band to sit in, which is the honest
        // picture of an edit made after the fact.
        respondents += 1;
        total += answer.value;
        byValue.set(answer.value, (byValue.get(answer.value) ?? 0) + 1);
      }
      const bands: RatingBand[] = [];
      for (let value = 1; value <= scale; value += 1) {
        const count = byValue.get(value) ?? 0;
        bands.push({ value, count, percent: percentOf(count, respondents) });
      }
      return {
        kind: "rating",
        respondents,
        scale,
        bands,
        // Null, not zero. A mean of zero is a claim that people rated this
        // zero, and the scale starts at one.
        mean: respondents > 0 ? total / respondents : null,
      };
    }

    case "shortText":
    case "longText": {
      const texts: TextAnswer[] = [];
      for (const { uid, answer } of answers) {
        if (!answer || answer.type !== "text" || answerIsEmpty(answer)) continue;
        texts.push({ uid, text: answer.text });
      }
      return { kind: "text", respondents: texts.length, texts };
    }

    case "imageUpload": {
      const rows: ImageAnswerRow[] = [];
      for (const { uid, answer } of answers) {
        if (!answer || answer.type !== "images" || answerIsEmpty(answer)) continue;
        rows.push({ uid, images: answer.images });
      }
      return { kind: "images", respondents: rows.length, rows };
    }
  }
}

/** The answers to one question, one entry per response, in the order given. */
export function answersFor(
  question: Pick<WorksheetQuestion, "id">,
  responses: Pick<ResponseDoc, "uid" | "answers">[],
): RespondentAnswer[] {
  return responses.map((response) => ({
    uid: response.uid,
    answer: response.answers[question.id],
  }));
}

// ---------------------------------------------------------------------------
// The export table
// ---------------------------------------------------------------------------

export type CsvTable = { header: string[]; rows: string[][] };

/**
 * The five columns that are about the RESPONSE rather than about an answer.
 * Named here so the header and the row builder cannot come to disagree about
 * how many there are.
 */
const META_HEADERS = [
  "state",
  "submitted at",
  "first opened at",
  "page opens",
  "active minutes",
] as const;

const MS_PER_MINUTE = 60 * 1000;

function isoOrBlank(date: Date | null): string {
  return date ? date.toISOString() : "";
}

/** An option id as words. Missing from the question means removed; present
 *  with nothing written on it means untitled. Two different facts, and a cell
 *  that told a reader the wrong one would send them looking for an edit
 *  nobody made. */
function labelOf(question: WorksheetQuestion, optionId: string): string {
  const option = (question.options ?? []).find((o) => o.id === optionId);
  if (!option) return REMOVED_OPTION_LABEL;
  return option.label.trim() || UNTITLED_OPTION_LABEL;
}

/**
 * One answer as one cell.
 *
 * Every branch returns a STRING, and an unanswered question returns the empty
 * one. A spreadsheet has no null: a column of "undefined" is what a reader
 * would otherwise get, and they would then have to guess whether it meant
 * "not answered" or "answered with the word undefined".
 */
function cellFor(question: WorksheetQuestion, answer: WorksheetAnswer | undefined): string {
  if (!answer || answerIsEmpty(answer)) return "";
  switch (answer.type) {
    case "text":
      return answer.text;
    case "choice":
      return labelOf(question, answer.optionId);
    case "choices": {
      // The AUTHOR'S order, not the order they were ticked in, so two people
      // who picked the same options export as the same string and a sort on
      // the column groups them. (The respond page already rebuilds the array
      // that way; this is the belt to its braces, for an answer written before
      // it did.) Ids the question no longer has come last, as one
      // "(option removed)" each, so the cell still says how many things were
      // picked.
      const options = question.options ?? [];
      const chosen = options
        .filter((option) => answer.optionIds.includes(option.id))
        .map((option) => option.label.trim() || UNTITLED_OPTION_LABEL);
      for (const optionId of answer.optionIds) {
        if (!options.some((option) => option.id === optionId)) chosen.push(REMOVED_OPTION_LABEL);
      }
      return chosen.join("; ");
    }
    case "rating":
      return String(answer.value);
    case "images":
      // Space-separated URLs. A comma would fight the file's own separator
      // through the escaping and come back quoted, and a semicolon reads as a
      // list of things rather than a list of links.
      return answer.images.map((image) => image.url).join(" ");
  }
}

/**
 * The whole export as a header row and a row per recipient.
 *
 * ── THE CELLS ARE RAW, AND ESCAPING HAPPENS ONCE ────────────────────────────
 * Nothing here quotes, escapes or neutralises anything. The caller hands this
 * table to `toCSV` in `@/lib/csv`, which runs every cell through
 * `escapeCsvCell`: that is where a leading `=`, `+`, `-` or `@` gains its tab
 * so Excel and Sheets cannot execute a cell somebody typed into a worksheet,
 * and where embedded commas, quotes and newlines are handled. Escaping here
 * TOO would double-prefix a formula and quote an already-quoted cell, so the
 * rule is one escape, at the file boundary, in the shared helper the other
 * exports use. `tests/worksheet-aggregate.test.mjs` asserts on the built file
 * rather than on these rows, so the guarantee is checked end to end.
 *
 * ── COLUMN ORDER ───────────────────────────────────────────────────────────
 * Who, then what they said, then how they went about it. The question columns
 * are in the worksheet's own item order (sections and page breaks contribute
 * nothing, having no answers), so the file reads down the page the recipient
 * read down. The uid leads because two people can share a display name and a
 * spreadsheet has no other way to tell them apart; NO EMAIL ADDRESS IS IN THIS
 * FILE, by construction rather than by filtering, because none is passed in.
 *
 * ── ROW ORDER ──────────────────────────────────────────────────────────────
 * By name, then by uid to break a tie. The staff table on screen is in
 * add-order because that is how a sender scans for who is missing; a
 * spreadsheet is looked up rather than scanned, and a stable alphabetical
 * order also makes two exports of the same circulation diffable.
 */
export function toCsvRows(
  circulation: Pick<CirculationDoc, "items">,
  responses: ResponseDoc[],
  names: Map<string, string>,
): CsvTable {
  const questions = questionsOf(circulation.items);
  const header = [
    "uid",
    "name",
    ...questions.map((question) => question.title.trim() || UNTITLED_QUESTION_HEADER),
    ...META_HEADERS,
  ];

  const nameOf = (uid: string) => (names.get(uid) ?? "").trim() || UNKNOWN_MEMBER_NAME;

  const rows = [...responses]
    .sort((a, b) => {
      const byName = nameOf(a.uid).localeCompare(nameOf(b.uid), "en-GB", {
        sensitivity: "base",
      });
      return byName !== 0 ? byName : a.uid.localeCompare(b.uid);
    })
    .map((response) => [
      response.uid,
      nameOf(response.uid),
      ...questions.map((question) => cellFor(question, response.answers[question.id])),
      RESPONSE_STATE_LABELS[response.state],
      isoOrBlank(response.submittedAt),
      isoOrBlank(response.activity.firstOpenedAt),
      String(Math.max(0, Math.round(response.activity.pageOpens))),
      // Rounded to the minute, matching `formatActiveTime` on screen: the
      // underlying number is a 30-second sampler, so a decimal would claim a
      // precision the measurement does not have.
      String(Math.round(response.activity.activeMs / MS_PER_MINUTE)),
    ]);

  return { header, rows };
}
