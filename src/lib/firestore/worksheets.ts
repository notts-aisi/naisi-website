/**
 * `worksheets/{worksheetId}`: the LIBRARY document, and the item model every
 * other part of the feature is shaped around. See `docs/worksheets.md` for the
 * contract this file implements.
 *
 * The one structural decision worth stating up front: a worksheet is never
 * edited once it has been sent. Circulating COPIES `items` onto the
 * circulation, and the recipient answers that copy. So this module is pure
 * shape and pure validation, and everything about who may write it lives in
 * `firestore.rules`.
 *
 * IMAGES ARE NEVER BINARY HERE. Every image on a question body, an option or
 * an answer is a `{ url, storagePath }` pair: the URL is what renders, the
 * storage path is what a delete sweep needs. Firestore documents have a 1 MB
 * ceiling and a base64 blob inside an `items` array would exhaust it after a
 * handful of options, so the pairing is not a style preference.
 *
 * TYPE-ONLY IMPORT FROM `circulations.ts`, ON PURPOSE. `circulations.ts`
 * imports `sanitizeItems` from HERE at runtime (it normalises the frozen copy
 * of the items). Importing `DEFAULT_REVIEW_CONFIG` back the other way as a
 * value would close that into a runtime cycle whose correctness depends on
 * module evaluation order, which is the kind of thing that works until a
 * bundler reorders it. `ReviewConfig` is a type, erased at compile time, so
 * the edge does not exist in the emitted graph. The consequence is deliberate
 * and visible in the doc type: `defaultReviewConfig` normalises to `null` when
 * the stored map is absent or partial, and the caller resolves it as
 * `worksheet.defaultReviewConfig ?? DEFAULT_REVIEW_CONFIG`. Defaults are
 * written down once, in `circulations.ts`, rather than twice.
 */
import { sanitizeBlocks, type Block } from "./newsletterBlocks";
import type { ReviewConfig } from "./circulations";

export const WORKSHEETS_COLLECTION = "worksheets";
export const WORKSHEET_FOLDERS_COLLECTION = "worksheetFolders";

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type WorksheetQuestionType =
  | "shortText"
  | "longText"
  | "singleChoice"
  | "multipleChoice"
  | "poll"
  | "rating"
  | "imageUpload";

/**
 * The picker's list AND the membership test, in source order, so a new type is
 * added in one place and cannot be half-added (present in the union, missing
 * from the editor's menu).
 */
export const WORKSHEET_QUESTION_TYPES: { type: WorksheetQuestionType; label: string }[] = [
  { type: "shortText", label: "Short text" },
  { type: "longText", label: "Long text" },
  { type: "singleChoice", label: "Single choice" },
  { type: "multipleChoice", label: "Multiple choice" },
  { type: "poll", label: "Poll" },
  { type: "rating", label: "Rating" },
  { type: "imageUpload", label: "Image upload" },
];

const QUESTION_TYPE_SET = new Set<string>(WORKSHEET_QUESTION_TYPES.map((t) => t.type));

export function isWorksheetQuestionType(value: unknown): value is WorksheetQuestionType {
  return typeof value === "string" && QUESTION_TYPE_SET.has(value);
}

/** Text questions carry their cap in characters or in words, never both. */
export type AnswerLimit = { unit: "characters" | "words"; max: number };

/**
 * Who may see a poll's aggregate. `staff` keeps it internal; `before-submit`
 * shows the running counts while the recipient is still answering (which
 * influences their answer, and is sometimes the point of asking); and
 * `after-submit` shows it only once they can no longer change their mind.
 */
export type PollResultsVisibility = "staff" | "before-submit" | "after-submit";

/**
 * Options carry an id because a reviewer fixing a typo in a label mid-flight
 * must not orphan every answer already given. Answers store `optionId`, never
 * the label.
 */
export type WorksheetOption = {
  id: string;
  label: string;
  imageUrl?: string;
  imageStoragePath?: string;
};

export type WorksheetQuestion = {
  kind: "question";
  id: string;
  type: WorksheetQuestionType;
  /** Plain text, always present. It is also the CSV column header on export. */
  title: string;
  /** Rich body under the title: richText, image and video blocks only. */
  body: Block[];
  required: boolean;
  /** Text types only. Absent means `defaultTextChars` characters. */
  limit?: AnswerLimit;
  /** Choice types only (singleChoice, multipleChoice, poll). */
  options?: WorksheetOption[];
  /** Rating only. The scale runs 1..max. */
  rating?: { max: number; minLabel?: string; maxLabel?: string };
  /** Poll only. */
  poll?: { resultsVisibility: PollResultsVisibility };
  /** imageUpload only. */
  upload?: { maxImages: number };
};

export type WorksheetSection = {
  kind: "section";
  id: string;
  heading: string;
  body: Block[];
};

export type WorksheetPageBreak = { kind: "pageBreak"; id: string };

export type WorksheetItem = WorksheetQuestion | WorksheetSection | WorksheetPageBreak;

/**
 * Budgets, in one place, so the editor's counters, `validateWorksheetItems`
 * and `firestore.rules` cannot drift apart. The rules file can only express
 * the three flat ones (`title`, `description` and `maxItems`); everything else
 * is enforced here and by the saving route, which is why the numbers have to
 * be readable from both sides rather than typed twice.
 *
 * The three that ARE mirrored are marked below and asserted against the text
 * of `firestore.rules` in `tests/worksheets-model.test.mjs`, because a comment
 * saying two layers agree is exactly the kind of claim that stops being true
 * without anybody noticing: the drift shows up as a save the editor allows and
 * the rules refuse, at somebody else's keyboard.
 */
export const WORKSHEET_LIMITS = {
  /** Worksheet title. Mirrored by `title.size() <= 120` in firestore.rules. */
  title: 120,
  /** Mirrored by `get('description', '').size() <= 1000` in firestore.rules. */
  description: 1000,
  /** Mirrored by `items.size() <= 100` in firestore.rules. */
  maxItems: 100,
  /** Questions specifically, sections and page breaks excluded. */
  maxQuestions: 60,
  minOptions: 2,
  maxOptions: 20,
  optionLabel: 120,
  sectionHeading: 120,
  questionTitle: 200,
  /** The cap a text question gets when the author sets none. */
  defaultTextChars: 2000,
  /** Ceiling on an authored `limit.max` when the unit is characters. */
  maxTextChars: 10000,
  /** Ceiling on an authored `limit.max` when the unit is words. */
  maxTextWords: 2000,
  /**
   * `rating.max` must sit in this band. Below three there is nothing to grade
   * with (use single choice); above ten nobody can tell 8 from 9.
   */
  ratingScaleMin: 3,
  ratingScaleMax: 10,
  /** The scale an author gets before they touch it. */
  defaultRatingMax: 5,
  /** `upload.maxImages` band. Storage cost is the reason for the ceiling. */
  minImagesPerAnswer: 1,
  maxImagesPerAnswer: 4,
  /** Mirrored by `name.size() <= 60` in firestore.rules. */
  folderName: 60,
} as const;

/**
 * Short, collision-unlikely id for one item or option, in the same shape as
 * `newQuestionId` in `events.ts` and `newBlockId` in `newsletterBlocks.ts`:
 * a prefix so a stray id is recognisable in a Firestore document by eye, a
 * base36 clock so ids sort roughly in creation order, and six random chars so
 * two items added in the same millisecond do not collide.
 *
 * NOT `slugId`: that builds a DOC id from a title, and an item's id must be
 * stable across every rename of its title (answers are keyed by it).
 */
export function newItemId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newOption(): WorksheetOption {
  return { id: newItemId("o"), label: "" };
}

export function emptyQuestion(type: WorksheetQuestionType): WorksheetQuestion {
  const base = {
    kind: "question" as const,
    id: newItemId("q"),
    type,
    title: "",
    body: [] as Block[],
    required: false,
  };
  switch (type) {
    case "shortText":
    case "longText":
      // No `limit` key: absent means `defaultTextChars`, and writing the
      // default out would make every later change to that default invisible to
      // every worksheet already authored.
      return base;
    case "singleChoice":
    case "multipleChoice":
      return { ...base, options: [newOption(), newOption()] };
    case "poll":
      return {
        ...base,
        options: [newOption(), newOption()],
        poll: { resultsVisibility: "staff" },
      };
    case "rating":
      return { ...base, rating: { max: WORKSHEET_LIMITS.defaultRatingMax } };
    case "imageUpload":
      return { ...base, upload: { maxImages: WORKSHEET_LIMITS.minImagesPerAnswer } };
  }
}

export function emptySection(): WorksheetSection {
  return { kind: "section", id: newItemId("s"), heading: "", body: [] };
}

export function emptyPageBreak(): WorksheetPageBreak {
  return { kind: "pageBreak", id: newItemId("pb") };
}

/** True for the three choice-shaped types, which are the ones needing options. */
export function questionHasOptions(type: WorksheetQuestionType): boolean {
  return type === "singleChoice" || type === "multipleChoice" || type === "poll";
}

/** True for the two free-text types, which are the ones `limit` applies to. */
export function questionHasText(type: WorksheetQuestionType): boolean {
  return type === "shortText" || type === "longText";
}

function isOption(raw: unknown): raw is WorksheetOption {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return typeof o.id === "string" && o.id.length > 0 && typeof o.label === "string";
}

/**
 * Structural check only, and deliberately loose about ranges. This is the
 * predicate `sanitizeItems` filters on, so a range check in here would DELETE
 * a question whose author typed 5000 into a limit box rather than telling them
 * about it. Ranges belong to `validateWorksheetItems`, which names the item.
 * Same split, for the same reason, as `isValidQuestion` and
 * `validateQuestionLimits` in `events.ts`.
 */
export function isValidItem(raw: unknown): raw is WorksheetItem {
  if (!raw || typeof raw !== "object") return false;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.length === 0) return false;
  switch (item.kind) {
    case "pageBreak":
      return true;
    case "section":
      return typeof item.heading === "string";
    case "question": {
      if (!isWorksheetQuestionType(item.type)) return false;
      if (typeof item.title !== "string") return false;
      if (questionHasOptions(item.type)) {
        // An options array that is not an array of options is not repairable
        // without inventing ids, and inventing ids silently re-homes answers.
        if (!Array.isArray(item.options) || !item.options.every(isOption)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * The block types a question's or a section's body may contain, which is a
 * SUBSET of the newsletter block set (docs/worksheets.md > Items: "richText,
 * image and video blocks only").
 *
 * `heading` and `divider` are the two `sanitizeBlocks` admits and a worksheet
 * does not. A question already renders its `title` as its heading, so a
 * heading block inside its body is a second, competing one that the CSV export
 * and the respond page would disagree about; a divider inside one question's
 * body divides nothing, because the question is already the unit the page
 * separates. Enforcing the subset HERE rather than in the editor means a body
 * that arrives from anywhere else (pasted out of a newsletter draft, written
 * by a route, restored from an older document) still lands in the shape the
 * respond page knows how to render.
 */
const WORKSHEET_BODY_BLOCK_TYPES: readonly string[] = ["richText", "image", "video"];

function sanitizeBody(raw: unknown): Block[] {
  return sanitizeBlocks(raw).filter((block) => WORKSHEET_BODY_BLOCK_TYPES.includes(block.type));
}

/**
 * Normalise one question's numeric settings.
 *
 * `clamp` separates the two callers, exactly as `normaliseQuestionLimits` in
 * `events.ts` does. Read paths clamp, so nothing out of range ever reaches an
 * answer validator whatever is stored. A SAVING route passes
 * `{ clampLimits: false }`, which keeps the authored number exactly as typed
 * and hands it to `validateWorksheetItems`, so the author is told their 50000
 * is too big instead of silently getting 10000. Clamping on both paths would
 * make the out-of-range branch of the validator unreachable from the real
 * pipeline.
 *
 * Nothing is ever written as `undefined`: an explicit undefined nested inside
 * an array is refused outright by a client-direct Firestore write, and the
 * items array is saved client-direct by the editor's autosave.
 */
function normaliseQuestion(q: WorksheetQuestion, clamp: boolean): WorksheetQuestion {
  const out: WorksheetQuestion = {
    kind: "question",
    id: q.id,
    type: q.type,
    title: typeof q.title === "string" ? q.title : "",
    body: sanitizeBody(q.body),
    required: Boolean(q.required),
  };

  if (questionHasText(q.type) && q.limit && typeof q.limit.max === "number") {
    const unit = q.limit.unit === "words" ? "words" : "characters";
    const ceiling =
      unit === "words" ? WORKSHEET_LIMITS.maxTextWords : WORKSHEET_LIMITS.maxTextChars;
    out.limit = {
      unit,
      max: clamp && Number.isFinite(q.limit.max) ? clampInt(q.limit.max, 1, ceiling) : q.limit.max,
    };
  }

  if (questionHasOptions(q.type)) {
    out.options = (q.options ?? []).map((o) => {
      const option: WorksheetOption = { id: o.id, label: o.label };
      // An option image is a URL plus its storage path, never a data blob.
      // Both or neither: half a pair cannot be deleted from the bucket later.
      if (typeof o.imageUrl === "string" && o.imageUrl && typeof o.imageStoragePath === "string") {
        option.imageUrl = o.imageUrl;
        option.imageStoragePath = o.imageStoragePath;
      }
      return option;
    });
  }

  if (q.type === "rating") {
    const raw = typeof q.rating?.max === "number" ? q.rating.max : WORKSHEET_LIMITS.defaultRatingMax;
    const rating: WorksheetQuestion["rating"] = {
      max:
        clamp && Number.isFinite(raw)
          ? clampInt(raw, WORKSHEET_LIMITS.ratingScaleMin, WORKSHEET_LIMITS.ratingScaleMax)
          : raw,
    };
    if (typeof q.rating?.minLabel === "string" && q.rating.minLabel) {
      rating.minLabel = q.rating.minLabel;
    }
    if (typeof q.rating?.maxLabel === "string" && q.rating.maxLabel) {
      rating.maxLabel = q.rating.maxLabel;
    }
    out.rating = rating;
  }

  if (q.type === "poll") {
    const visibility = q.poll?.resultsVisibility;
    out.poll = {
      resultsVisibility:
        visibility === "before-submit" || visibility === "after-submit" ? visibility : "staff",
    };
  }

  if (q.type === "imageUpload") {
    const raw =
      typeof q.upload?.maxImages === "number"
        ? q.upload.maxImages
        : WORKSHEET_LIMITS.minImagesPerAnswer;
    out.upload = {
      maxImages:
        clamp && Number.isFinite(raw)
          ? clampInt(raw, WORKSHEET_LIMITS.minImagesPerAnswer, WORKSHEET_LIMITS.maxImagesPerAnswer)
          : raw,
    };
  }

  return out;
}

/**
 * Read-path sanitiser: never throws, drops what it cannot understand, and
 * clamps numeric settings into range. A malformed item is dropped rather than
 * repaired, because a repaired item is a guess about somebody's intent and the
 * read path has nobody left to ask.
 *
 * The item COUNT is not truncated. The rules cap a client write at
 * `maxItems`, so a longer array can only have come from the Admin SDK, and
 * silently hiding its tail on read would mean the next autosave persisted the
 * truncation. `validateWorksheetItems` reports it instead.
 */
export function sanitizeItems(
  raw: unknown,
  options: { clampLimits?: boolean } = {},
): WorksheetItem[] {
  if (!Array.isArray(raw)) return [];
  const clamp = options.clampLimits !== false;
  return raw.filter(isValidItem).map((item): WorksheetItem => {
    if (item.kind === "question") return normaliseQuestion(item, clamp);
    if (item.kind === "section") {
      return {
        kind: "section",
        id: item.id,
        heading: item.heading,
        body: sanitizeBody(item.body),
      };
    }
    return { kind: "pageBreak", id: item.id };
  });
}

export type WorksheetItemProblem = { itemId: string; message: string };

/**
 * Range-check a whole worksheet, naming the item at fault so the saving route
 * can answer 400 with a sentence the author can act on, and the editor can
 * scroll to the question.
 *
 * Call it on the output of `sanitizeItems(raw, { clampLimits: false })`: on a
 * clamped list the range branches are unreachable, and a validator that cannot
 * fail is a validator nobody notices has stopped working.
 */
export function validateWorksheetItems(items: WorksheetItem[]): WorksheetItemProblem[] {
  const problems: WorksheetItemProblem[] = [];

  if (items.length > WORKSHEET_LIMITS.maxItems) {
    problems.push({
      itemId: items[WORKSHEET_LIMITS.maxItems].id,
      message: `A worksheet can hold ${WORKSHEET_LIMITS.maxItems} items. This one has ${items.length}.`,
    });
  }

  const questions = questionsOf(items);
  if (questions.length > WORKSHEET_LIMITS.maxQuestions) {
    problems.push({
      itemId: questions[WORKSHEET_LIMITS.maxQuestions].id,
      message: `A worksheet can hold ${WORKSHEET_LIMITS.maxQuestions} questions. This one has ${questions.length}.`,
    });
  }

  for (const item of items) {
    if (item.kind === "pageBreak") continue;

    if (item.kind === "section") {
      if (item.heading.trim().length === 0) {
        problems.push({ itemId: item.id, message: "This section needs a heading." });
      } else if (item.heading.length > WORKSHEET_LIMITS.sectionHeading) {
        problems.push({
          itemId: item.id,
          message: `This section's heading is over the ${WORKSHEET_LIMITS.sectionHeading}-character limit.`,
        });
      }
      continue;
    }

    if (item.title.trim().length === 0) {
      problems.push({ itemId: item.id, message: "This question needs a title." });
    } else if (item.title.length > WORKSHEET_LIMITS.questionTitle) {
      problems.push({
        itemId: item.id,
        message: `This question's title is over the ${WORKSHEET_LIMITS.questionTitle}-character limit.`,
      });
    }

    if (questionHasOptions(item.type)) {
      const options = item.options ?? [];
      if (options.length < WORKSHEET_LIMITS.minOptions) {
        problems.push({
          itemId: item.id,
          message: `This question needs at least ${WORKSHEET_LIMITS.minOptions} options.`,
        });
      }
      if (options.length > WORKSHEET_LIMITS.maxOptions) {
        problems.push({
          itemId: item.id,
          message: `This question has ${options.length} options. The limit is ${WORKSHEET_LIMITS.maxOptions}.`,
        });
      }
      // Duplicate ids are the quiet one: two options answer to the same key,
      // so one recipient's choice reads back as the other option's, and the
      // poll aggregate double-counts. Cheap to detect, impossible to spot
      // afterwards.
      const seen = new Set<string>();
      let duplicate = false;
      for (const option of options) {
        if (seen.has(option.id)) duplicate = true;
        seen.add(option.id);
        if (option.label.trim().length === 0) {
          problems.push({ itemId: item.id, message: "Every option needs a label." });
          break;
        }
      }
      if (duplicate) {
        problems.push({ itemId: item.id, message: "Two options share an id. Re-add one of them." });
      }
      for (const option of options) {
        if (option.label.length > WORKSHEET_LIMITS.optionLabel) {
          problems.push({
            itemId: item.id,
            message: `An option label is over the ${WORKSHEET_LIMITS.optionLabel}-character limit.`,
          });
          break;
        }
      }
    }

    if (questionHasText(item.type) && item.limit) {
      const ceiling =
        item.limit.unit === "words" ? WORKSHEET_LIMITS.maxTextWords : WORKSHEET_LIMITS.maxTextChars;
      if (!Number.isInteger(item.limit.max)) {
        problems.push({ itemId: item.id, message: "The answer limit is not a whole number." });
      } else if (item.limit.max < 1 || item.limit.max > ceiling) {
        problems.push({
          itemId: item.id,
          message: `The answer limit is ${item.limit.max} ${item.limit.unit}. It must be between 1 and ${ceiling}.`,
        });
      }
    }

    if (item.type === "rating") {
      const max = item.rating?.max;
      if (typeof max !== "number" || !Number.isInteger(max)) {
        problems.push({ itemId: item.id, message: "The rating scale is not a whole number." });
      } else if (max < WORKSHEET_LIMITS.ratingScaleMin || max > WORKSHEET_LIMITS.ratingScaleMax) {
        problems.push({
          itemId: item.id,
          message: `The rating scale is 1 to ${max}. It must top out between ${WORKSHEET_LIMITS.ratingScaleMin} and ${WORKSHEET_LIMITS.ratingScaleMax}.`,
        });
      }
    }

    if (item.type === "imageUpload") {
      const max = item.upload?.maxImages;
      if (typeof max !== "number" || !Number.isInteger(max)) {
        problems.push({ itemId: item.id, message: "The image allowance is not a whole number." });
      } else if (
        max < WORKSHEET_LIMITS.minImagesPerAnswer ||
        max > WORKSHEET_LIMITS.maxImagesPerAnswer
      ) {
        problems.push({
          itemId: item.id,
          message: `This question allows ${max} images. It must allow between ${WORKSHEET_LIMITS.minImagesPerAnswer} and ${WORKSHEET_LIMITS.maxImagesPerAnswer}.`,
        });
      }
    }
  }

  return problems;
}

export function questionsOf(items: WorksheetItem[]): WorksheetQuestion[] {
  return items.filter((item): item is WorksheetQuestion => item.kind === "question");
}

/**
 * Split the items into the pages the respond view renders, one per page break.
 *
 * A page break is a SEPARATOR, not a page, so a break as the first item, as
 * the last item, or two in a row cannot produce an empty page: the respond
 * view paginates on this array's length, and an empty page is a screen with a
 * Next button and nothing above it, which reads as a broken worksheet.
 *
 * A worksheet with no content returns `[]` rather than one empty page, so the
 * caller renders its "nothing to answer" state rather than a blank page one.
 */
export function pagesOf(items: WorksheetItem[]): WorksheetItem[][] {
  const pages: WorksheetItem[][] = [];
  let current: WorksheetItem[] = [];
  for (const item of items) {
    if (item.kind === "pageBreak") {
      if (current.length > 0) {
        pages.push(current);
        current = [];
      }
      continue;
    }
    current.push(item);
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * One recipient's answer to one question, keyed by question id on the response
 * document. Choice answers store OPTION IDS, never labels, so a mid-flight
 * label edit does not rewrite what anybody said.
 */
export type WorksheetAnswer =
  | { type: "text"; text: string }
  | { type: "choice"; optionId: string }
  | { type: "choices"; optionIds: string[] }
  | { type: "rating"; value: number }
  | { type: "images"; images: { url: string; storagePath: string }[] };

/** The answer shape each question type expects, in one place. */
const ANSWER_TYPE_FOR_QUESTION: Record<WorksheetQuestionType, WorksheetAnswer["type"]> = {
  shortText: "text",
  longText: "text",
  singleChoice: "choice",
  multipleChoice: "choices",
  poll: "choice",
  rating: "rating",
  imageUpload: "images",
};

export function answerIsEmpty(answer: WorksheetAnswer): boolean {
  switch (answer.type) {
    case "text":
      return typeof answer.text !== "string" || answer.text.trim().length === 0;
    case "choice":
      return !answer.optionId;
    case "choices":
      return !Array.isArray(answer.optionIds) || answer.optionIds.length === 0;
    case "rating":
      // Zero is how a cleared rating comes back from the widget, so it is
      // "unanswered" rather than "out of range". Otherwise clearing a rating
      // on an optional question would block the whole submission.
      return !Number.isFinite(answer.value) || answer.value <= 0;
    case "images":
      return !Array.isArray(answer.images) || answer.images.length === 0;
  }
}

/**
 * Words, counted the way a person counts them: runs of non-whitespace.
 *
 * Deliberately not a locale-aware segmenter. The number is shown next to a
 * word limit the author typed, and a counter that disagrees with the reader's
 * own count by a word or two on hyphenation is worse than one that is simply
 * predictable.
 */
export function countWords(text: string): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * The cap in force for one text question: authored, or the default.
 *
 * `Number.isFinite` rather than `typeof === "number"`, matching the two
 * neighbours below. A stored NaN or Infinity is a number by type, and returning
 * one here would silently DISABLE the cap rather than fall back to it: every
 * length comparison against NaN is false, so `validateAnswer` would accept any
 * length of text and the counter beside the box would read "NaN remaining".
 * The saving path passes `clampLimits: false` (so the author is told their
 * number is out of range instead of having it changed under them), which means
 * a nonsense value CAN be stored, so this read path has to survive one.
 */
export function answerLimitOf(question: WorksheetQuestion): AnswerLimit {
  const max = question.limit?.max;
  if (question.limit && typeof max === "number" && Number.isFinite(max)) return question.limit;
  return { unit: "characters", max: WORKSHEET_LIMITS.defaultTextChars };
}

/** The top of a rating question's scale, defaulted and clamped into the band. */
export function ratingScaleOf(question: WorksheetQuestion): number {
  const max = question.rating?.max;
  if (typeof max !== "number" || !Number.isFinite(max)) return WORKSHEET_LIMITS.defaultRatingMax;
  return clampInt(max, WORKSHEET_LIMITS.ratingScaleMin, WORKSHEET_LIMITS.ratingScaleMax);
}

/** How many images one imageUpload question accepts, defaulted and clamped. */
export function imageAllowanceOf(question: WorksheetQuestion): number {
  const max = question.upload?.maxImages;
  if (typeof max !== "number" || !Number.isFinite(max)) return WORKSHEET_LIMITS.minImagesPerAnswer;
  return clampInt(max, WORKSHEET_LIMITS.minImagesPerAnswer, WORKSHEET_LIMITS.maxImagesPerAnswer);
}

/**
 * Check one answer against its question. Returns a sentence for the recipient
 * or null.
 *
 * EMPTINESS IS NOT THIS FUNCTION'S JOB. An empty answer returns null here and
 * is caught, if the question is required, by `validateSubmission`. Splitting
 * it that way means an autosave that writes a cleared value cannot produce a
 * range error about a value nobody entered, and the "you have to answer this"
 * message is worded once.
 */
export function validateAnswer(
  question: WorksheetQuestion,
  answer: WorksheetAnswer,
): string | null {
  if (!answer || typeof answer !== "object" || typeof answer.type !== "string") {
    return "That answer is not in a shape this question understands.";
  }
  const expected = ANSWER_TYPE_FOR_QUESTION[question.type];
  if (!expected) return "That question type is not one this worksheet understands.";
  if (answer.type !== expected) {
    return "That answer is not in a shape this question understands.";
  }
  if (answerIsEmpty(answer)) return null;

  switch (answer.type) {
    case "text": {
      const limit = answerLimitOf(question);
      if (limit.unit === "words") {
        const words = countWords(answer.text);
        if (words > limit.max) {
          return `This answer is ${words} words. The limit is ${limit.max}.`;
        }
        return null;
      }
      if (answer.text.length > limit.max) {
        return `This answer is ${answer.text.length} characters. The limit is ${limit.max}.`;
      }
      return null;
    }
    case "choice": {
      const options = question.options ?? [];
      if (!options.some((o) => o.id === answer.optionId)) {
        return "That option is no longer on this question.";
      }
      return null;
    }
    case "choices": {
      const options = question.options ?? [];
      if (answer.optionIds.length > options.length) {
        return "That answer picks more options than this question has.";
      }
      const seen = new Set<string>();
      for (const id of answer.optionIds) {
        if (typeof id !== "string" || !options.some((o) => o.id === id)) {
          return "One of those options is no longer on this question.";
        }
        if (seen.has(id)) return "That answer picks the same option twice.";
        seen.add(id);
      }
      return null;
    }
    case "rating": {
      const max = ratingScaleOf(question);
      if (!Number.isInteger(answer.value)) return "A rating has to be a whole number.";
      if (answer.value < 1 || answer.value > max) {
        return `A rating has to be between 1 and ${max}.`;
      }
      return null;
    }
    case "images": {
      const allowance = imageAllowanceOf(question);
      if (answer.images.length > allowance) {
        return `This question takes ${allowance} image${allowance === 1 ? "" : "s"}. That answer has ${answer.images.length}.`;
      }
      for (const image of answer.images) {
        // Both halves or neither: the URL is what renders and the storage path
        // is what a delete sweep needs, so a half pair is an orphan blob.
        if (
          !image ||
          typeof image.url !== "string" ||
          !image.url ||
          typeof image.storagePath !== "string" ||
          !image.storagePath
        ) {
          return "One of those images did not finish uploading. Remove it and try again.";
        }
      }
      return null;
    }
  }
}

export type WorksheetProgress = {
  answered: number;
  total: number;
  requiredAnswered: number;
  required: number;
};

/**
 * The four numbers behind the progress bars. Written by the recipient's client
 * on every autosave and RE-DERIVED by the submit route, which is the
 * authority: the stored copy is cosmetic, so a client that lies about it
 * cannot talk its way past a required question.
 */
export function computeProgress(
  items: WorksheetItem[],
  answers: Record<string, WorksheetAnswer>,
): WorksheetProgress {
  let answered = 0;
  let required = 0;
  let requiredAnswered = 0;
  const questions = questionsOf(items);
  for (const question of questions) {
    const answer = answers?.[question.id];
    const filled = answer !== undefined && answer !== null && !answerIsEmpty(answer);
    if (filled) answered += 1;
    if (question.required) {
      required += 1;
      if (filled) requiredAnswered += 1;
    }
  }
  return { answered, total: questions.length, requiredAnswered, required };
}

export type SubmissionProblem = { questionId: string; message: string };

/**
 * Everything wrong with a submission, in question order, so the respond page
 * can list it and the submit route can answer 400 with the first line.
 *
 * Both callers run the SAME function against the SAME items (the circulation's
 * frozen copy), so a submission the page allows is one the route accepts. That
 * is the whole reason this lives in a shared module rather than in the route.
 */
export function validateSubmission(
  items: WorksheetItem[],
  answers: Record<string, WorksheetAnswer>,
): SubmissionProblem[] {
  const problems: SubmissionProblem[] = [];
  for (const question of questionsOf(items)) {
    const answer = answers?.[question.id];
    if (answer === undefined || answer === null) {
      if (question.required) {
        problems.push({ questionId: question.id, message: "This question needs an answer." });
      }
      continue;
    }
    const message = validateAnswer(question, answer);
    if (message) {
      problems.push({ questionId: question.id, message });
      continue;
    }
    if (question.required && answerIsEmpty(answer)) {
      problems.push({ questionId: question.id, message: "This question needs an answer." });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type WorksheetDoc = {
  id: string;
  title: string;
  description: string;
  folderId: string | null;
  authorUid: string;
  /** Admin-only flag. A private worksheet is listed for admins and its author. */
  private: boolean;
  items: WorksheetItem[];
  /**
   * The review toggles a circulation of this worksheet starts with, or null
   * when the worksheet never set them (see the module comment for why the
   * fallback constant lives in `circulations.ts`). Resolve as
   * `defaultReviewConfig ?? DEFAULT_REVIEW_CONFIG`.
   */
  defaultReviewConfig: ReviewConfig | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastCirculatedAt: Date | null;
};

export type WorksheetFolderDoc = {
  id: string;
  name: string;
  createdByUid: string;
  createdAt: Date | null;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * All four toggles or nothing.
 *
 * A partial map would otherwise be silently completed with defaults here AND
 * at the circulate route, in two places that could disagree. "Not set" is a
 * state the caller can resolve once, against the one constant.
 */
function reviewConfigOrNull(raw: unknown): ReviewConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Raw;
  const keys = [
    "perQuestionFeedback",
    "perQuestionScoring",
    "overallFeedback",
    "returnToRecipient",
  ] as const;
  if (!keys.every((key) => typeof r[key] === "boolean")) return null;
  return {
    perQuestionFeedback: r.perQuestionFeedback as boolean,
    perQuestionScoring: r.perQuestionScoring as boolean,
    overallFeedback: r.overallFeedback as boolean,
    returnToRecipient: r.returnToRecipient as boolean,
  };
}

export function normalizeWorksheet(id: string, data: Raw): WorksheetDoc {
  return {
    id,
    title: str(data.title),
    description: str(data.description),
    folderId: typeof data.folderId === "string" && data.folderId ? data.folderId : null,
    authorUid: str(data.authorUid),
    // Defaults to NOT private: the rule that hides a private worksheet reads
    // the stored field, so a document missing it is one every committee member
    // can already read, and pretending otherwise in the UI would show an empty
    // library instead of the worksheets people can see.
    private: data.private === true,
    items: sanitizeItems(data.items),
    defaultReviewConfig: reviewConfigOrNull(data.defaultReviewConfig),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    lastCirculatedAt: tsToDate(data.lastCirculatedAt),
  };
}

export function normalizeWorksheetFolder(id: string, data: Raw): WorksheetFolderDoc {
  return {
    id,
    name: str(data.name),
    createdByUid: str(data.createdByUid),
    createdAt: tsToDate(data.createdAt),
  };
}
