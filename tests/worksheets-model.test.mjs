/**
 * Unit tests for the worksheets DATA MODEL: the pure helpers in
 * `src/lib/firestore/worksheets.ts` and `src/lib/firestore/circulations.ts`,
 * plus the video-provider resolver they share with the newsletter blocks.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Firestore rules can express two things about a worksheet: the title is short
 * enough and there are at most a hundred items. Everything else that decides
 * whether a worksheet is answerable lives in these functions, and three of
 * them are load-bearing in a way no other layer can catch:
 *
 *  1. **The submit route and the respond page must agree.** Both call
 *     `validateSubmission` against the SAME items (the circulation's frozen
 *     copy), so a submission the page allows is one the route accepts. A
 *     divergence there is a person who fills in a worksheet, presses Submit,
 *     and is told no with no way to find out why.
 *
 *  2. **Sanitising must drop, never repair, and must clamp, never delete.**
 *     `sanitizeItems` is `raw.filter(isValidItem)`, so a range check inside the
 *     predicate would make an author who typed 50000 into a limit box lose the
 *     whole question with no message. Ranges are `validateWorksheetItems`'s
 *     job, which names the item. The same split, for the same reason, as
 *     `isValidQuestion` and `validateQuestionLimits` in `events.ts`.
 *
 *  3. **A page break is a separator, not a page.** A break first, last or
 *     doubled must not produce an empty page, because the respond view
 *     paginates on the array's length and an empty page is a screen with a Next
 *     button and nothing above it.
 *
 * `taskStatusForResponse` gets its own section because it is the only place the
 * response lifecycle and the task board touch: every route that moves a
 * worksheet task goes through it, so a wrong answer here is a board that
 * disagrees with the thing it mirrors.
 *
 * ## Why the loader dance
 *
 * Same root cause as `form-question-limits.test.mjs` and
 * `course-window.test.mjs`: this repo's Node predates the v22.18 that strips
 * TypeScript natively, so the module graph is transpiled in memory with the
 * `typescript` devDependency `npx tsc --noEmit` already uses. The transpile
 * path is taken unconditionally rather than as a fallback, so the behaviour is
 * identical on every Node the team runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const WORKSHEETS_MODULE = join(SRC, "lib", "firestore", "worksheets.ts");
const CIRCULATIONS_MODULE = join(SRC, "lib", "firestore", "circulations.ts");
const BLOCKS_MODULE = join(SRC, "lib", "firestore", "newsletterBlocks.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. `worksheets.ts` pulls in
 * `newsletterBlocks.ts` for the block sanitiser, which pulls in `marked` to
 * render legacy markdown. No worksheet item reaches that, and stubbing it
 * keeps this file honest about what it is testing.
 *
 * `circulations.ts` imports `TaskStatus` from `tasks.ts` as a TYPE, which
 * TypeScript erases outright, so the task module never appears in this graph
 * and needs no stub. That is worth noticing rather than assuming: if somebody
 * turns that into a value import, this file starts loading the whole task
 * model and the failure will say so.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  ["marked", "export const marked = { parse: (s) => s };"],
]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** file path (or stub key) -> data: URL of its module source. Memoised. */
const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(file) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(file));
}

const {
  WORKSHEET_LIMITS,
  WORKSHEET_QUESTION_TYPES,
  answerIsEmpty,
  answerLimitOf,
  computeProgress,
  countWords,
  emptyPageBreak,
  emptyQuestion,
  emptySection,
  imageAllowanceOf,
  isValidItem,
  newItemId,
  normalizeWorksheet,
  normalizeWorksheetFolder,
  pagesOf,
  questionsOf,
  ratingScaleOf,
  sanitizeItems,
  validateAnswer,
  validateSubmission,
  validateWorksheetItems,
} = await loadTs(WORKSHEETS_MODULE);

const {
  CIRCULATION_LIMITS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_REVIEW_CONFIG,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_DESCRIPTIONS,
  NOTIFICATION_EVENT_LABELS,
  RESPONSE_STATES,
  RESPONSE_STATE_LABELS,
  circulationStaffUids,
  isTerminalResponseState,
  normalizeNotifications,
  normalizeResponse,
  normalizeReview,
  normalizeReviewConfig,
  taskStatusForResponse,
} = await loadTs(CIRCULATIONS_MODULE);

const { loomIdFromUrl, videoEmbedFromUrl, youtubeIdFromUrl } = await loadTs(BLOCKS_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function question(overrides = {}) {
  return {
    kind: "question",
    id: "q1",
    type: "shortText",
    title: "What did you notice?",
    body: [],
    required: false,
    ...overrides,
  };
}

function choiceQuestion(overrides = {}) {
  return question({
    id: "qc",
    type: "singleChoice",
    options: [
      { id: "o1", label: "Yes" },
      { id: "o2", label: "No" },
    ],
    ...overrides,
  });
}

const SECTION = { kind: "section", id: "s1", heading: "Part one", body: [] };
const BREAK = { kind: "pageBreak", id: "pb1" };

// ---------------------------------------------------------------------------
// Item ids and blanks
// ---------------------------------------------------------------------------

describe("item ids and blank items", () => {
  it("prefixes ids so a stray one is recognisable in a Firestore document", () => {
    assert.match(newItemId("q"), /^q_[a-z0-9]+_[a-z0-9]{1,6}$/);
    assert.match(newItemId("pb"), /^pb_/);
  });

  it("does not collide across a burst of calls in the same millisecond", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newItemId("q")));
    assert.equal(ids.size, 500);
  });

  it("gives every question type a blank that survives its own validator", () => {
    for (const { type } of WORKSHEET_QUESTION_TYPES) {
      const blank = emptyQuestion(type);
      assert.equal(blank.kind, "question");
      assert.equal(blank.type, type);
      assert.equal(isValidItem(blank), true, `${type} blank failed isValidItem`);
    }
  });

  it("gives choice types two blank options, which is the minimum", () => {
    for (const type of ["singleChoice", "multipleChoice", "poll"]) {
      assert.equal(emptyQuestion(type).options.length, WORKSHEET_LIMITS.minOptions);
    }
  });

  it("leaves `limit` ABSENT on a new text question", () => {
    // Writing the default out would freeze it into every worksheet already
    // authored, so a later change to `defaultTextChars` would reach none of
    // them. Absent means "the current default", which is the intent.
    assert.equal("limit" in emptyQuestion("shortText"), false);
    assert.equal(answerLimitOf(emptyQuestion("shortText")).max, WORKSHEET_LIMITS.defaultTextChars);
  });

  it("builds a valid blank section and page break", () => {
    assert.equal(isValidItem(emptySection()), true);
    assert.equal(isValidItem(emptyPageBreak()), true);
  });
});

// ---------------------------------------------------------------------------
// pagesOf
// ---------------------------------------------------------------------------

describe("pagesOf: a page break is a separator, not a page", () => {
  it("returns nothing at all for an empty worksheet", () => {
    // Rather than one empty page: the respond view then renders its "nothing to
    // answer" state instead of a blank page one with a Next button.
    assert.deepEqual(pagesOf([]), []);
  });

  it("returns one page when there are no breaks", () => {
    const items = [question(), SECTION];
    assert.deepEqual(pagesOf(items), [items]);
  });

  it("splits on a break", () => {
    const a = question({ id: "qa" });
    const b = question({ id: "qb" });
    assert.deepEqual(pagesOf([a, BREAK, b]), [[a], [b]]);
  });

  it("does NOT make an empty page from a leading break", () => {
    const a = question({ id: "qa" });
    assert.deepEqual(pagesOf([BREAK, a]), [[a]]);
  });

  it("does NOT make an empty page from a trailing break", () => {
    const a = question({ id: "qa" });
    assert.deepEqual(pagesOf([a, BREAK]), [[a]]);
  });

  it("does NOT make an empty page from two breaks in a row", () => {
    const a = question({ id: "qa" });
    const b = question({ id: "qb" });
    assert.deepEqual(
      pagesOf([a, { kind: "pageBreak", id: "pb1" }, { kind: "pageBreak", id: "pb2" }, b]),
      [[a], [b]],
    );
  });

  it("returns nothing for a worksheet that is only breaks", () => {
    assert.deepEqual(pagesOf([BREAK, { kind: "pageBreak", id: "pb2" }]), []);
  });

  it("keeps sections on the page they were placed on", () => {
    const a = question({ id: "qa" });
    assert.deepEqual(pagesOf([SECTION, a, BREAK, SECTION]), [[SECTION, a], [SECTION]]);
  });
});

describe("questionsOf", () => {
  it("keeps questions and drops sections and breaks", () => {
    const a = question({ id: "qa" });
    const b = question({ id: "qb" });
    assert.deepEqual(
      questionsOf([SECTION, a, BREAK, b]).map((q) => q.id),
      ["qa", "qb"],
    );
  });
});

// ---------------------------------------------------------------------------
// countWords
// ---------------------------------------------------------------------------

describe("countWords", () => {
  it("counts nothing in an empty or whitespace-only answer", () => {
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   \n\t "), 0);
  });

  it("counts runs of non-whitespace, the way a person counts", () => {
    assert.equal(countWords("one"), 1);
    assert.equal(countWords("one two three"), 3);
    assert.equal(countWords("  one   two  "), 2);
    assert.equal(countWords("one\ntwo\tthree four"), 4);
  });

  it("counts punctuation as part of its word, not as a word", () => {
    assert.equal(countWords("hello, world!"), 2);
  });

  it("counts a hyphenated word once", () => {
    assert.equal(countWords("well-meaning"), 1);
  });

  it("returns zero for a non-string rather than throwing", () => {
    assert.equal(countWords(null), 0);
    assert.equal(countWords(undefined), 0);
    assert.equal(countWords(42), 0);
  });
});

// ---------------------------------------------------------------------------
// answerIsEmpty
// ---------------------------------------------------------------------------

describe("answerIsEmpty", () => {
  it("treats whitespace-only text as empty", () => {
    assert.equal(answerIsEmpty({ type: "text", text: "  \n " }), true);
    assert.equal(answerIsEmpty({ type: "text", text: "x" }), false);
  });

  it("treats a cleared choice, choice list and image list as empty", () => {
    assert.equal(answerIsEmpty({ type: "choice", optionId: "" }), true);
    assert.equal(answerIsEmpty({ type: "choices", optionIds: [] }), true);
    assert.equal(answerIsEmpty({ type: "images", images: [] }), true);
  });

  it("treats a zero or negative rating as UNANSWERED rather than out of range", () => {
    // Zero is how a cleared rating comes back from the widget. Calling it out
    // of range would block the whole submission over an optional question the
    // person deliberately left blank.
    assert.equal(answerIsEmpty({ type: "rating", value: 0 }), true);
    assert.equal(answerIsEmpty({ type: "rating", value: 3 }), false);
  });
});

// ---------------------------------------------------------------------------
// validateAnswer
// ---------------------------------------------------------------------------

describe("validateAnswer: text", () => {
  it("accepts text within the default character cap", () => {
    const q = question();
    assert.equal(validateAnswer(q, { type: "text", text: "x".repeat(2000) }), null);
  });

  it("refuses text over the default character cap, and says by how much", () => {
    const q = question();
    const message = validateAnswer(q, { type: "text", text: "x".repeat(2001) });
    assert.match(message, /2001 characters/);
    assert.match(message, /2000/);
  });

  it("honours an authored character limit in place of the default", () => {
    const q = question({ limit: { unit: "characters", max: 10 } });
    assert.equal(validateAnswer(q, { type: "text", text: "0123456789" }), null);
    assert.match(validateAnswer(q, { type: "text", text: "0123456789x" }), /11 characters/);
  });

  it("honours a WORD limit, counted with countWords", () => {
    const q = question({ type: "longText", limit: { unit: "words", max: 3 } });
    assert.equal(validateAnswer(q, { type: "text", text: "one two three" }), null);
    assert.match(validateAnswer(q, { type: "text", text: "one two three four" }), /4 words/);
  });

  it("refuses an answer of the wrong SHAPE for the question", () => {
    const q = question();
    assert.match(validateAnswer(q, { type: "rating", value: 3 }), /not in a shape/);
  });

  it("returns null for an empty answer, leaving required-ness to the submission check", () => {
    // Split deliberately: an autosave that writes a cleared value must not
    // produce a range error about a value nobody entered, and "you have to
    // answer this" is worded once, in validateSubmission.
    const q = question({ required: true, limit: { unit: "characters", max: 5 } });
    assert.equal(validateAnswer(q, { type: "text", text: "" }), null);
  });
});

describe("validateAnswer: choices", () => {
  it("accepts an option the question still carries", () => {
    assert.equal(validateAnswer(choiceQuestion(), { type: "choice", optionId: "o1" }), null);
  });

  it("refuses an option id the question no longer carries", () => {
    // The reason answers store option IDS rather than labels: a reviewer fixing
    // a typo mid-flight must not orphan every answer already given. An id that
    // has actually been removed is a different matter and is reported.
    assert.match(
      validateAnswer(choiceQuestion(), { type: "choice", optionId: "gone" }),
      /no longer on this question/,
    );
  });

  it("wants a `choices` answer for multipleChoice and a `choice` for poll", () => {
    const multi = choiceQuestion({ id: "qm", type: "multipleChoice" });
    assert.equal(validateAnswer(multi, { type: "choices", optionIds: ["o1", "o2"] }), null);
    assert.match(validateAnswer(multi, { type: "choice", optionId: "o1" }), /not in a shape/);

    const poll = choiceQuestion({ id: "qp", type: "poll", poll: { resultsVisibility: "staff" } });
    assert.equal(validateAnswer(poll, { type: "choice", optionId: "o2" }), null);
  });

  it("refuses a repeated option in a multiple-choice answer", () => {
    const multi = choiceQuestion({ id: "qm", type: "multipleChoice" });
    assert.match(
      validateAnswer(multi, { type: "choices", optionIds: ["o1", "o1"] }),
      /same option twice/,
    );
  });

  it("refuses more picks than the question has options", () => {
    const multi = choiceQuestion({ id: "qm", type: "multipleChoice" });
    assert.match(
      validateAnswer(multi, { type: "choices", optionIds: ["o1", "o2", "o1"] }),
      /more options than/,
    );
  });

  it("refuses a non-string entry in the option list", () => {
    const multi = choiceQuestion({ id: "qm", type: "multipleChoice" });
    assert.match(validateAnswer(multi, { type: "choices", optionIds: [7] }), /no longer/);
  });
});

describe("validateAnswer: rating", () => {
  it("accepts a whole number inside the scale", () => {
    const q = question({ id: "qr", type: "rating", rating: { max: 5 } });
    assert.equal(validateAnswer(q, { type: "rating", value: 1 }), null);
    assert.equal(validateAnswer(q, { type: "rating", value: 5 }), null);
  });

  it("refuses a value above the scale", () => {
    const q = question({ id: "qr", type: "rating", rating: { max: 5 } });
    assert.match(validateAnswer(q, { type: "rating", value: 6 }), /between 1 and 5/);
  });

  it("refuses a fractional rating", () => {
    const q = question({ id: "qr", type: "rating", rating: { max: 5 } });
    assert.match(validateAnswer(q, { type: "rating", value: 3.5 }), /whole number/);
  });

  it("falls back to the default scale when the question carries no rating settings", () => {
    const q = question({ id: "qr", type: "rating" });
    assert.equal(ratingScaleOf(q), WORKSHEET_LIMITS.defaultRatingMax);
    assert.equal(validateAnswer(q, { type: "rating", value: 5 }), null);
    assert.match(validateAnswer(q, { type: "rating", value: 6 }), /between 1 and 5/);
  });

  it("clamps an out-of-band stored scale rather than trusting it", () => {
    assert.equal(ratingScaleOf(question({ type: "rating", rating: { max: 99 } })), 10);
    assert.equal(ratingScaleOf(question({ type: "rating", rating: { max: 1 } })), 3);
  });
});

describe("validateAnswer: images", () => {
  const IMG = { url: "https://example.test/a.png", storagePath: "worksheet-uploads/c/u/a.png" };

  it("accepts up to the question's allowance", () => {
    const q = question({ id: "qi", type: "imageUpload", upload: { maxImages: 2 } });
    assert.equal(validateAnswer(q, { type: "images", images: [IMG, IMG] }), null);
  });

  it("refuses more than the allowance", () => {
    const q = question({ id: "qi", type: "imageUpload", upload: { maxImages: 1 } });
    assert.match(
      validateAnswer(q, { type: "images", images: [IMG, IMG] }),
      /takes 1 image\b/,
    );
  });

  it("refuses half an image pair, because a URL with no path is an orphan blob", () => {
    const q = question({ id: "qi", type: "imageUpload", upload: { maxImages: 2 } });
    assert.match(
      validateAnswer(q, { type: "images", images: [{ url: "https://example.test/a.png" }] }),
      /did not finish uploading/,
    );
    assert.match(
      validateAnswer(q, { type: "images", images: [{ storagePath: "p" }] }),
      /did not finish uploading/,
    );
  });

  it("defaults the allowance to one and clamps a stored value into the band", () => {
    assert.equal(imageAllowanceOf(question({ type: "imageUpload" })), 1);
    assert.equal(
      imageAllowanceOf(question({ type: "imageUpload", upload: { maxImages: 99 } })),
      WORKSHEET_LIMITS.maxImagesPerAnswer,
    );
  });
});

// ---------------------------------------------------------------------------
// computeProgress
// ---------------------------------------------------------------------------

describe("computeProgress", () => {
  const items = [
    SECTION,
    question({ id: "q1", required: true }),
    BREAK,
    question({ id: "q2", required: true }),
    question({ id: "q3" }),
  ];

  it("counts questions only, never sections or breaks", () => {
    const p = computeProgress(items, {});
    assert.deepEqual(p, { answered: 0, total: 3, requiredAnswered: 0, required: 2 });
  });

  it("counts a filled answer and ignores an empty one", () => {
    const p = computeProgress(items, {
      q1: { type: "text", text: "yes" },
      q2: { type: "text", text: "   " },
      q3: { type: "text", text: "also yes" },
    });
    assert.deepEqual(p, { answered: 2, total: 3, requiredAnswered: 1, required: 2 });
  });

  it("copes with an answers map that is missing or holds unknown question ids", () => {
    assert.deepEqual(computeProgress(items, undefined), {
      answered: 0,
      total: 3,
      requiredAnswered: 0,
      required: 2,
    });
    const p = computeProgress(items, { nope: { type: "text", text: "orphan" } });
    assert.equal(p.answered, 0);
  });

  it("reports every required question answered once they are", () => {
    const p = computeProgress(items, {
      q1: { type: "text", text: "a" },
      q2: { type: "text", text: "b" },
    });
    assert.equal(p.requiredAnswered, 2);
    assert.equal(p.required, 2);
  });
});

// ---------------------------------------------------------------------------
// validateSubmission
// ---------------------------------------------------------------------------

describe("validateSubmission", () => {
  it("passes a complete submission", () => {
    const items = [question({ id: "q1", required: true }), choiceQuestion({ required: true })];
    assert.deepEqual(
      validateSubmission(items, {
        q1: { type: "text", text: "done" },
        qc: { type: "choice", optionId: "o1" },
      }),
      [],
    );
  });

  it("names a required question with no answer at all", () => {
    const items = [question({ id: "q1", required: true })];
    assert.deepEqual(validateSubmission(items, {}), [
      { questionId: "q1", message: "This question needs an answer." },
    ]);
  });

  it("names a required question whose answer is present but empty", () => {
    const items = [question({ id: "q1", required: true })];
    assert.deepEqual(validateSubmission(items, { q1: { type: "text", text: "  " } }), [
      { questionId: "q1", message: "This question needs an answer." },
    ]);
  });

  it("lets an OPTIONAL question stay blank", () => {
    const items = [question({ id: "q1" })];
    assert.deepEqual(validateSubmission(items, { q1: { type: "text", text: "" } }), []);
  });

  it("surfaces a per-answer failure alongside the required ones, in question order", () => {
    const items = [
      question({ id: "q1", required: true }),
      question({ id: "q2", limit: { unit: "characters", max: 3 } }),
      question({ id: "q3", required: true }),
    ];
    const problems = validateSubmission(items, { q2: { type: "text", text: "much too long" } });
    assert.deepEqual(
      problems.map((p) => p.questionId),
      ["q1", "q2", "q3"],
    );
    assert.match(problems[1].message, /13 characters/);
  });

  it("reports the shape failure rather than the required one when both apply", () => {
    // Otherwise "this question needs an answer" would be the message for an
    // answer that is present and simply the wrong type, which sends the person
    // looking at the wrong thing.
    const items = [question({ id: "q1", required: true })];
    const problems = validateSubmission(items, { q1: { type: "rating", value: 4 } });
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /not in a shape/);
  });

  it("ignores sections and page breaks entirely", () => {
    assert.deepEqual(validateSubmission([SECTION, BREAK], {}), []);
  });
});

// ---------------------------------------------------------------------------
// sanitizeItems
// ---------------------------------------------------------------------------

describe("sanitizeItems: drops what it cannot understand", () => {
  it("returns an empty list for anything that is not an array", () => {
    for (const raw of [undefined, null, {}, "items", 7]) {
      assert.deepEqual(sanitizeItems(raw), []);
    }
  });

  it("drops a malformed item and keeps its neighbours", () => {
    const good = question({ id: "q1" });
    const items = sanitizeItems([
      good,
      null,
      "nonsense",
      { kind: "question" },
      { kind: "unknown", id: "u1" },
      { id: "no-kind" },
      BREAK,
    ]);
    assert.deepEqual(
      items.map((i) => i.id),
      ["q1", "pb1"],
    );
  });

  it("drops a question whose type is not one this model knows", () => {
    assert.deepEqual(sanitizeItems([question({ type: "handwriting" })]), []);
  });

  it("drops a choice question whose options are not options", () => {
    // Repairing would mean INVENTING option ids, and an invented id silently
    // re-homes every answer already given.
    assert.deepEqual(sanitizeItems([choiceQuestion({ options: ["Yes", "No"] })]), []);
    assert.deepEqual(sanitizeItems([choiceQuestion({ options: "Yes" })]), []);
    assert.deepEqual(sanitizeItems([choiceQuestion({ options: [{ label: "no id" }] })]), []);
  });

  it("keeps a choice question with real options", () => {
    const [item] = sanitizeItems([choiceQuestion()]);
    assert.deepEqual(
      item.options.map((o) => o.id),
      ["o1", "o2"],
    );
  });

  it("drops half an option-image pair rather than storing an orphan URL", () => {
    const [item] = sanitizeItems([
      choiceQuestion({
        options: [
          { id: "o1", label: "Yes", imageUrl: "https://example.test/a.png" },
          { id: "o2", label: "No" },
        ],
      }),
    ]);
    assert.equal("imageUrl" in item.options[0], false);
  });

  it("keeps a complete option-image pair", () => {
    const [item] = sanitizeItems([
      choiceQuestion({
        options: [
          {
            id: "o1",
            label: "Yes",
            imageUrl: "https://example.test/a.png",
            imageStoragePath: "worksheet-images/w1/a.png",
          },
          { id: "o2", label: "No" },
        ],
      }),
    ]);
    assert.equal(item.options[0].imageStoragePath, "worksheet-images/w1/a.png");
  });

  it("forces `required` to a real boolean", () => {
    const [item] = sanitizeItems([question({ required: "yes" })]);
    assert.equal(item.required, true);
    const [other] = sanitizeItems([question({ required: undefined })]);
    assert.equal(other.required, false);
  });
});

describe("sanitizeItems: clamps on read, keeps the authored value on save", () => {
  it("clamps a character limit into the ceiling by default", () => {
    const [item] = sanitizeItems([
      question({ limit: { unit: "characters", max: 50000 } }),
    ]);
    assert.equal(item.limit.max, WORKSHEET_LIMITS.maxTextChars);
  });

  it("clamps a WORD limit against the word ceiling, not the character one", () => {
    const [item] = sanitizeItems([question({ limit: { unit: "words", max: 50000 } })]);
    assert.equal(item.limit.max, WORKSHEET_LIMITS.maxTextWords);
  });

  it("clamps a rating scale and an image allowance into their bands", () => {
    const [rating] = sanitizeItems([
      question({ id: "qr", type: "rating", rating: { max: 99 } }),
    ]);
    assert.equal(rating.rating.max, WORKSHEET_LIMITS.ratingScaleMax);
    const [upload] = sanitizeItems([
      question({ id: "qi", type: "imageUpload", upload: { maxImages: 0 } }),
    ]);
    assert.equal(upload.upload.maxImages, WORKSHEET_LIMITS.minImagesPerAnswer);
  });

  it("rounds a fractional limit DOWN when clamping", () => {
    const [item] = sanitizeItems([question({ limit: { unit: "characters", max: 12.9 } })]);
    assert.equal(item.limit.max, 12);
  });

  it("KEEPS the authored value untouched with clampLimits false", () => {
    // The saving route passes this so validateWorksheetItems can tell the
    // author their 50000 is too big, instead of silently handing them 10000.
    // Clamping on both paths would make the range branch unreachable from the
    // real pipeline, which is a validator nobody notices has stopped working.
    const [item] = sanitizeItems([question({ limit: { unit: "characters", max: 50000 } })], {
      clampLimits: false,
    });
    assert.equal(item.limit.max, 50000);
    const [rating] = sanitizeItems(
      [question({ id: "qr", type: "rating", rating: { max: 99 } })],
      { clampLimits: false },
    );
    assert.equal(rating.rating.max, 99);
  });

  it("normalises an unknown poll visibility to staff-only", () => {
    const [item] = sanitizeItems([
      choiceQuestion({ type: "poll", poll: { resultsVisibility: "everyone" } }),
    ]);
    assert.equal(item.poll.resultsVisibility, "staff");
  });

  it("never leaves a key set to undefined, which a client-direct write refuses", () => {
    const [item] = sanitizeItems([question({ limit: undefined, options: undefined })]);
    for (const [key, value] of Object.entries(item)) {
      assert.notEqual(value, undefined, `${key} was undefined`);
    }
  });

  it("keeps the text cap in force when a nonsense limit was stored", () => {
    // The save path stores the authored number as typed (clampLimits false),
    // so a NaN or an Infinity CAN reach the read path. `answerLimitOf` has to
    // fall back rather than hand one on: every length comparison against NaN
    // is false, so returning it would silently disable the cap altogether and
    // print "NaN characters remaining" beside the box.
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const stored = question({ limit: { unit: "characters", max } });
      assert.equal(answerLimitOf(stored).max, WORKSHEET_LIMITS.defaultTextChars);
      assert.equal(answerLimitOf(stored).unit, "characters");
      assert.equal(
        validateAnswer(stored, { type: "text", text: "x".repeat(20000) }),
        `This answer is 20000 characters. The limit is ${WORKSHEET_LIMITS.defaultTextChars}.`,
      );
    }
  });

  it("drops heading and divider blocks from a question or section body", () => {
    // The contract admits richText, image and video in a body and nothing
    // else, while the shared newsletter sanitiser also passes heading and
    // divider. A question already renders its title as its heading, so a
    // heading block inside its body is a second competing one.
    const body = [
      { id: "b1", type: "richText", html: "<p>Read this first.</p>" },
      { id: "b2", type: "heading", text: "Section", level: 2 },
      { id: "b3", type: "divider" },
      { id: "b4", type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    ];
    const [q, section] = sanitizeItems([question({ body }), { ...SECTION, body }]);
    assert.deepEqual(
      q.body.map((b) => b.type),
      ["richText", "video"],
    );
    assert.deepEqual(
      section.body.map((b) => b.type),
      ["richText", "video"],
    );
  });

  it("does not truncate an over-long item list on the read path", () => {
    // The rules cap a client write at 100, so a longer array can only have come
    // from the Admin SDK. Hiding its tail on read would mean the next autosave
    // persisted the truncation. validateWorksheetItems reports it instead.
    const raw = Array.from({ length: 105 }, (_, i) => ({ kind: "pageBreak", id: `pb_${i}` }));
    assert.equal(sanitizeItems(raw).length, 105);
  });
});

// ---------------------------------------------------------------------------
// validateWorksheetItems
// ---------------------------------------------------------------------------

describe("validateWorksheetItems: names the item, never deletes it", () => {
  it("passes a clean worksheet", () => {
    assert.deepEqual(validateWorksheetItems([question(), choiceQuestion(), SECTION, BREAK]), []);
  });

  it("reports an empty question title", () => {
    const problems = validateWorksheetItems([question({ title: "   " })]);
    assert.deepEqual(problems, [{ itemId: "q1", message: "This question needs a title." }]);
  });

  it("reports an over-long question title and section heading", () => {
    const problems = validateWorksheetItems([
      question({ title: "x".repeat(201) }),
      { kind: "section", id: "s1", heading: "y".repeat(121), body: [] },
    ]);
    assert.deepEqual(
      problems.map((p) => p.itemId),
      ["q1", "s1"],
    );
  });

  it("reports an empty section heading", () => {
    assert.deepEqual(validateWorksheetItems([{ kind: "section", id: "s1", heading: "", body: [] }]), [
      { itemId: "s1", message: "This section needs a heading." },
    ]);
  });

  it("reports fewer than two options", () => {
    const problems = validateWorksheetItems([
      choiceQuestion({ options: [{ id: "o1", label: "Only one" }] }),
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /at least 2 options/);
  });

  it("reports more than twenty options", () => {
    const options = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    const problems = validateWorksheetItems([choiceQuestion({ options })]);
    assert.match(problems[0].message, /21 options/);
  });

  it("reports DUPLICATE option ids, which double-count a poll and mis-read an answer", () => {
    const problems = validateWorksheetItems([
      choiceQuestion({
        options: [
          { id: "o1", label: "Yes" },
          { id: "o1", label: "Also yes" },
        ],
      }),
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /share an id/);
  });

  it("reports an unlabelled option", () => {
    const problems = validateWorksheetItems([
      choiceQuestion({
        options: [
          { id: "o1", label: "Yes" },
          { id: "o2", label: "  " },
        ],
      }),
    ]);
    assert.match(problems[0].message, /Every option needs a label/);
  });

  it("reports a rating scale outside 3 to 10, and a fractional one", () => {
    const low = validateWorksheetItems([
      question({ id: "qr", type: "rating", rating: { max: 2 } }),
    ]);
    assert.match(low[0].message, /between 3 and 10/);
    const high = validateWorksheetItems([
      question({ id: "qr", type: "rating", rating: { max: 11 } }),
    ]);
    assert.match(high[0].message, /between 3 and 10/);
    const fractional = validateWorksheetItems([
      question({ id: "qr", type: "rating", rating: { max: 4.5 } }),
    ]);
    assert.match(fractional[0].message, /whole number/);
  });

  it("reports a text limit outside its ceiling, per unit", () => {
    const chars = validateWorksheetItems([
      question({ limit: { unit: "characters", max: 10001 } }),
    ]);
    assert.match(chars[0].message, /between 1 and 10000/);
    const words = validateWorksheetItems([question({ limit: { unit: "words", max: 2001 } })]);
    assert.match(words[0].message, /between 1 and 2000/);
    const zero = validateWorksheetItems([question({ limit: { unit: "characters", max: 0 } })]);
    assert.match(zero[0].message, /between 1 and 10000/);
  });

  it("reports an image allowance outside 1 to 4", () => {
    const problems = validateWorksheetItems([
      question({ id: "qi", type: "imageUpload", upload: { maxImages: 9 } }),
    ]);
    assert.match(problems[0].message, /between 1 and 4/);
  });

  it("reports more than sixty questions, naming the first one over", () => {
    const items = Array.from({ length: 61 }, (_, i) => question({ id: `q${i}` }));
    const problems = validateWorksheetItems(items);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].itemId, "q60");
    assert.match(problems[0].message, /61/);
  });

  it("reports more than a hundred items, naming the first one over", () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ kind: "pageBreak", id: `pb_${i}` }));
    const problems = validateWorksheetItems(items);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].itemId, "pb_100");
  });

  it("does not count sections and breaks against the question budget", () => {
    const items = [
      ...Array.from({ length: 60 }, (_, i) => question({ id: `q${i}` })),
      SECTION,
      BREAK,
    ];
    assert.deepEqual(validateWorksheetItems(items), []);
  });
});

// ---------------------------------------------------------------------------
// Worksheet document normalisers
// ---------------------------------------------------------------------------

describe("normalizeWorksheet", () => {
  it("fills every field from an empty document rather than throwing", () => {
    const doc = normalizeWorksheet("w1", {});
    assert.equal(doc.id, "w1");
    assert.equal(doc.title, "");
    assert.equal(doc.folderId, null);
    assert.equal(doc.private, false);
    assert.deepEqual(doc.items, []);
    assert.equal(doc.defaultReviewConfig, null);
    assert.equal(doc.createdAt, null);
  });

  it("defaults `private` to FALSE, which is what the read rule already says", () => {
    // A document missing the field is one every committee member can read, so
    // reading it as private in the UI would show an empty library instead of
    // the worksheets people can actually see.
    assert.equal(normalizeWorksheet("w1", { private: "yes" }).private, false);
    assert.equal(normalizeWorksheet("w1", { private: true }).private, true);
  });

  it("reads a review config only when ALL FOUR toggles are present", () => {
    // A partial map would otherwise be completed with defaults here AND at the
    // circulate route, in two places that could disagree.
    assert.equal(
      normalizeWorksheet("w1", { defaultReviewConfig: { perQuestionFeedback: true } })
        .defaultReviewConfig,
      null,
    );
    assert.deepEqual(
      normalizeWorksheet("w1", { defaultReviewConfig: DEFAULT_REVIEW_CONFIG })
        .defaultReviewConfig,
      DEFAULT_REVIEW_CONFIG,
    );
  });

  it("converts Firestore timestamps through their toDate", () => {
    const when = new Date("2026-09-01T09:00:00Z");
    const doc = normalizeWorksheet("w1", { createdAt: { toDate: () => when } });
    assert.equal(doc.createdAt.getTime(), when.getTime());
  });

  it("sanitises the stored items on the way out", () => {
    const doc = normalizeWorksheet("w1", { items: [question(), "junk", null] });
    assert.equal(doc.items.length, 1);
  });
});

describe("normalizeWorksheetFolder", () => {
  it("fills every field from an empty document", () => {
    assert.deepEqual(normalizeWorksheetFolder("f1", {}), {
      id: "f1",
      name: "",
      createdByUid: "",
      createdAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// circulations
// ---------------------------------------------------------------------------

describe("circulationStaffUids", () => {
  it("de-duplicates when the sender is also the author", () => {
    assert.deepEqual(
      circulationStaffUids({ senderUid: "a", authorUid: "a", reviewerUids: ["b"] }),
      ["a", "b"],
    );
  });

  it("de-duplicates a reviewer who is also the sender", () => {
    assert.deepEqual(
      circulationStaffUids({ senderUid: "a", authorUid: "b", reviewerUids: ["a", "c", "c"] }),
      ["a", "b", "c"],
    );
  });

  it("keeps a stable order: sender, author, then the reviewers as named", () => {
    assert.deepEqual(
      circulationStaffUids({ senderUid: "s", authorUid: "au", reviewerUids: ["r2", "r1"] }),
      ["s", "au", "r2", "r1"],
    );
  });

  it("drops empty and non-string entries rather than storing a blank staff member", () => {
    assert.deepEqual(
      circulationStaffUids({ senderUid: "s", authorUid: "", reviewerUids: ["", null, "r"] }),
      ["s", "r"],
    );
  });

  it("copes with a missing reviewer list", () => {
    assert.deepEqual(
      circulationStaffUids({ senderUid: "s", authorUid: "a", reviewerUids: undefined }),
      ["s", "a"],
    );
  });
});

describe("taskStatusForResponse", () => {
  const RETURNING = { ...DEFAULT_REVIEW_CONFIG, returnToRecipient: true };
  const NOT_RETURNING = { ...DEFAULT_REVIEW_CONFIG, returnToRecipient: false };

  it("maps not-opened to todo and started to in-progress, whatever the config", () => {
    for (const config of [RETURNING, NOT_RETURNING]) {
      assert.equal(taskStatusForResponse("not-opened", config), "todo");
      assert.equal(taskStatusForResponse("started", config), "in-progress");
    }
  });

  it("sends a submitted response to Review when the feedback is coming back", () => {
    assert.equal(taskStatusForResponse("submitted", RETURNING), "review");
  });

  it("sends it straight to Done when it is NOT", () => {
    // Leaving the task open with returnToRecipient off would be a queue nobody
    // ever empties: there is no further step for anyone to take.
    assert.equal(taskStatusForResponse("submitted", NOT_RETURNING), "done");
  });

  it("maps reviewed to done under either setting", () => {
    assert.equal(taskStatusForResponse("reviewed", RETURNING), "done");
    assert.equal(taskStatusForResponse("reviewed", NOT_RETURNING), "done");
  });

  it("covers every declared response state", () => {
    // A new state added to the union without a branch here would leave a
    // worksheet task frozen at whatever status it happened to hold.
    for (const state of RESPONSE_STATES) {
      assert.ok(taskStatusForResponse(state, RETURNING), `${state} has no task status`);
    }
  });
});

describe("response states", () => {
  it("treats submitted and reviewed as frozen, and the other two as writable", () => {
    assert.equal(isTerminalResponseState("submitted"), true);
    assert.equal(isTerminalResponseState("reviewed"), true);
    assert.equal(isTerminalResponseState("not-opened"), false);
    assert.equal(isTerminalResponseState("started"), false);
  });

  it("labels every state", () => {
    for (const state of RESPONSE_STATES) {
      assert.equal(typeof RESPONSE_STATE_LABELS[state], "string");
      assert.ok(RESPONSE_STATE_LABELS[state].length > 0);
    }
  });
});

describe("review config and notification defaults", () => {
  it("defaults to feedback on, scoring off, returned to the recipient", () => {
    assert.deepEqual(DEFAULT_REVIEW_CONFIG, {
      perQuestionFeedback: true,
      perQuestionScoring: false,
      overallFeedback: true,
      returnToRecipient: true,
    });
  });

  it("fills a partial review config from the defaults, key by key", () => {
    assert.deepEqual(normalizeReviewConfig({ perQuestionScoring: true }), {
      ...DEFAULT_REVIEW_CONFIG,
      perQuestionScoring: true,
    });
    assert.deepEqual(normalizeReviewConfig(null), DEFAULT_REVIEW_CONFIG);
    assert.deepEqual(normalizeReviewConfig({ overallFeedback: "yes" }), DEFAULT_REVIEW_CONFIG);
  });

  it("gives every notification event a label and a one-sentence description", () => {
    for (const event of NOTIFICATION_EVENTS) {
      assert.ok(NOTIFICATION_EVENT_LABELS[event]?.length > 0, `${event} has no label`);
      const description = NOTIFICATION_EVENT_DESCRIPTIONS[event];
      assert.ok(description?.length > 0, `${event} has no description`);
      assert.match(description, /\.$/, `${event}'s description is not a sentence`);
    }
  });

  it("ships dueSoon push off and copyEdited off entirely", () => {
    // A reminder is the message that arrives while somebody is asleep, and a
    // sender fixing a typo should not have to silence a broadcast first.
    assert.equal(DEFAULT_NOTIFICATIONS.dueSoon.push, false);
    assert.deepEqual(DEFAULT_NOTIFICATIONS.copyEdited, { email: false, push: false });
  });

  it("fills a partial notification map without losing the events it omits", () => {
    const filled = normalizeNotifications({ assigned: { email: false } });
    assert.deepEqual(filled.assigned, { email: false, push: true });
    assert.deepEqual(filled.submitted, DEFAULT_NOTIFICATIONS.submitted);
    assert.deepEqual(Object.keys(filled).sort(), [...NOTIFICATION_EVENTS].sort());
  });

  it("caps recipients per request and reviewers where the routes expect", () => {
    assert.equal(CIRCULATION_LIMITS.maxRecipientsPerRequest, 100);
    assert.equal(CIRCULATION_LIMITS.maxReviewers, 5);
    assert.equal(CIRCULATION_LIMITS.overall, 4000);
  });
});

describe("normalizeResponse", () => {
  it("takes the recipient's uid from the DOC ID, not the stored field", () => {
    // A response whose `uid` field had drifted would otherwise be read under
    // one identity and written under another, and the rules key on the id.
    const doc = normalizeResponse("recipA", { uid: "someone-else" });
    assert.equal(doc.uid, "recipA");
  });

  it("falls back to not-opened for an unknown state", () => {
    assert.equal(normalizeResponse("u", { state: "half-done" }).state, "not-opened");
    assert.equal(normalizeResponse("u", { state: "submitted" }).state, "submitted");
  });

  it("shapes the answers map and drops entries it cannot read", () => {
    const doc = normalizeResponse("u", {
      answers: {
        q1: { type: "text", text: "hello" },
        q2: { type: "choice", optionId: "o1" },
        q3: { type: "choices", optionIds: ["o1", 7, "o2"] },
        q4: { type: "rating", value: 4 },
        q5: { type: "images", images: [{ url: "u", storagePath: "p" }, { url: "u" }] },
        q6: { type: "text" },
        q7: "nonsense",
        q8: { type: "handwriting", strokes: [] },
      },
    });
    assert.deepEqual(Object.keys(doc.answers).sort(), ["q1", "q2", "q3", "q4", "q5"]);
    assert.deepEqual(doc.answers.q3.optionIds, ["o1", "o2"]);
    assert.equal(doc.answers.q5.images.length, 1);
  });

  it("fills progress and activity from a document that carries neither", () => {
    const doc = normalizeResponse("u", {});
    assert.deepEqual(doc.progress, { answered: 0, total: 0, requiredAnswered: 0, required: 0 });
    assert.deepEqual(doc.activity, {
      firstOpenedAt: null,
      pageOpens: 0,
      activeMs: 0,
      lastActiveAt: null,
    });
    assert.equal(doc.returned, null);
    assert.equal(doc.taskId, null);
  });

  it("keeps only the feedback halves of a returned block, never a score", () => {
    const doc = normalizeResponse("u", {
      returned: {
        perQuestion: { q1: { feedback: "Good", score: 9 }, q2: { score: 3 } },
        overall: "Nicely done.",
        returnedByUid: "su1",
      },
    });
    assert.deepEqual(doc.returned.perQuestion, { q1: { feedback: "Good" } });
    assert.equal("score" in doc.returned.perQuestion.q1, false);
  });
});

describe("normalizeReview", () => {
  it("keeps feedback and scores, which is the whole point of the separate document", () => {
    const doc = normalizeReview("recipA", {
      perQuestion: { q1: { feedback: "Say why", score: 7 } },
      overall: "Solid.",
      updatedByUid: "su1",
    });
    assert.deepEqual(doc.perQuestion.q1, { feedback: "Say why", score: 7 });
    assert.equal(doc.overall, "Solid.");
  });

  it("drops an entry with neither a comment nor a score", () => {
    // A leftover from a cleared box would otherwise make "has this question
    // been reviewed" answer yes.
    const doc = normalizeReview("recipA", { perQuestion: { q1: {}, q2: { feedback: "x" } } });
    assert.deepEqual(Object.keys(doc.perQuestion), ["q2"]);
  });

  it("fills every field from an empty document", () => {
    const doc = normalizeReview("recipA", {});
    assert.deepEqual(doc, {
      id: "recipA",
      perQuestion: {},
      overall: "",
      updatedAt: null,
      updatedByUid: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Video providers
// ---------------------------------------------------------------------------

describe("loomIdFromUrl", () => {
  const ID = "0123456789abcdef0123456789abcdef";

  it("reads a share URL", () => {
    assert.equal(loomIdFromUrl(`https://www.loom.com/share/${ID}`), ID);
    assert.equal(loomIdFromUrl(`https://loom.com/share/${ID}`), ID);
  });

  it("reads an embed URL", () => {
    assert.equal(loomIdFromUrl(`https://www.loom.com/embed/${ID}`), ID);
  });

  it("ignores the tracking query Loom appends to a copied link", () => {
    assert.equal(loomIdFromUrl(`https://www.loom.com/share/${ID}?sid=abc-123`), ID);
  });

  it("lower-cases the id so two spellings of one video are one id", () => {
    assert.equal(loomIdFromUrl(`https://www.loom.com/share/${ID.toUpperCase()}`), ID);
  });

  it("refuses a hex run that is not exactly 32 characters", () => {
    assert.equal(loomIdFromUrl(`https://www.loom.com/share/${ID}ab`), null);
    assert.equal(loomIdFromUrl(`https://www.loom.com/share/${ID.slice(0, 31)}`), null);
  });

  it("refuses a bare id, deliberately", () => {
    // Unlike YouTube, where an 11-character id is recognisable from its `v=`
    // slot. A bare 32-character hex string is just a hex string, and treating
    // any such blob as a video would turn a pasted hash into a broken embed.
    assert.equal(loomIdFromUrl(ID), null);
  });

  it("refuses another host, a non-video path and rubbish", () => {
    assert.equal(loomIdFromUrl(`https://notloom.com/share/${ID}`), null);
    assert.equal(loomIdFromUrl(`https://www.loom.com/looks/${ID}`), null);
    assert.equal(loomIdFromUrl("not a url"), null);
    assert.equal(loomIdFromUrl(""), null);
    assert.equal(loomIdFromUrl("   "), null);
  });
});

describe("videoEmbedFromUrl", () => {
  const LOOM_ID = "0123456789abcdef0123456789abcdef";

  it("resolves a YouTube watch URL to the URLs the existing renderers build", () => {
    // Pinned against the two renderers this helper is meant to replace, so
    // adopting it cannot change what either of them shows: BlockView embeds
    // through youtube-nocookie, BlockRenderer links a i.ytimg thumbnail.
    const embed = videoEmbedFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.deepEqual(embed, {
      provider: "youtube",
      id: "dQw4w9WgXcQ",
      embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      watchUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("resolves the other YouTube shapes youtubeIdFromUrl already accepted", () => {
    for (const raw of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
    ]) {
      assert.equal(videoEmbedFromUrl(raw).id, youtubeIdFromUrl(raw));
      assert.equal(videoEmbedFromUrl(raw).provider, "youtube");
    }
  });

  it("resolves a Loom share URL, with no thumbnail", () => {
    // Loom has no public thumbnail endpoint, and the null is what tells an
    // email renderer to fall back to a plain link rather than a broken image.
    assert.deepEqual(videoEmbedFromUrl(`https://www.loom.com/share/${LOOM_ID}`), {
      provider: "loom",
      id: LOOM_ID,
      embedUrl: `https://www.loom.com/embed/${LOOM_ID}`,
      watchUrl: `https://www.loom.com/share/${LOOM_ID}`,
      thumbnailUrl: null,
    });
  });

  it("normalises a Loom embed URL to the same result as its share URL", () => {
    assert.deepEqual(
      videoEmbedFromUrl(`https://www.loom.com/embed/${LOOM_ID}`),
      videoEmbedFromUrl(`https://www.loom.com/share/${LOOM_ID}`),
    );
  });

  it("returns null for anything neither provider recognises", () => {
    for (const raw of ["", "   ", "https://vimeo.com/123456", "https://example.test/video.mp4"]) {
      assert.equal(videoEmbedFromUrl(raw), null);
    }
  });

  it("leaves youtubeIdFromUrl behaving exactly as it did", () => {
    // The Loom work must not have moved the YouTube matcher: three existing
    // features (courses materials, the newsletter editor, the events block
    // view) validate pasted URLs through it.
    assert.equal(youtubeIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
    assert.equal(youtubeIdFromUrl(`https://www.loom.com/share/${LOOM_ID}`), null);
  });
});

// ---------------------------------------------------------------------------
// The two layers, read together
// ---------------------------------------------------------------------------

/**
 * `WORKSHEET_LIMITS` and `CIRCULATION_LIMITS` each carry comments saying a
 * number is "mirrored" in `firestore.rules`. Nothing made that true, and a
 * comment claiming two layers agree is the kind of claim that quietly stops
 * being one: the drift does not show up as a failing test, it shows up as a
 * save the editor allowed and the rules refused, at somebody else's keyboard,
 * with `permission-denied` and no clue which cap disagreed.
 *
 * So this section reads the rules file and pins every mirrored number, in the
 * same shape `tests/course-pages.test.mjs` pins the startHere and cohort caps.
 * It fails in both directions: change the constant and the rule stays put, or
 * change the rule and the constant stays put, and the number no longer matches.
 *
 * Only the WORKSHEETS section of the file is searched. `name.size() <= 80`
 * exists twice elsewhere for other collections, so a whole-file match would
 * let the folder-name cap be satisfied by an unrelated block.
 */
const RULES = readFileSync(join(REPO_ROOT, "firestore.rules"), "utf8");

const WORKSHEET_RULES = (() => {
  const start = RULES.indexOf("======================= WORKSHEETS =======================");
  const end = RULES.indexOf("=== credentials (committee only, client-side encrypted) ===");
  const section = start >= 0 && end > start ? RULES.slice(start, end) : "";
  // COMMENT LINES ARE STRIPPED before anything is matched. That block is
  // heavily commented, and the comments quote the clauses they explain (the
  // `private` one spells out the `.get('private', false)` form it deliberately
  // does NOT use). Matching against prose would let a number that exists only
  // in a sentence satisfy an assertion about the rule, which is a guard that
  // passes while the layer it guards has drifted.
  return section
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
})();

/** The number in the first clause matching `pattern`, which must have one group. */
function ruleCap(pattern) {
  const found = WORKSHEET_RULES.match(pattern);
  assert.ok(found, `firestore.rules no longer has a clause matching ${pattern}`);
  return Number(found[1]);
}

describe("firestore.rules and the limit constants agree", () => {
  it("finds the worksheets section of the rules file at all", () => {
    // If the banner comments are renamed, every assertion below would match an
    // empty string and pass vacuously. This is the test that stops that.
    assert.ok(
      WORKSHEET_RULES.includes("match /worksheets/{worksheetId}"),
      "the WORKSHEETS section markers in firestore.rules have moved or been renamed",
    );
    assert.ok(WORKSHEET_RULES.includes("match /circulations/{circulationId}"));
  });

  it("caps the worksheet title at WORKSHEET_LIMITS.title", () => {
    assert.equal(ruleCap(/title\.size\(\) <= (\d+)/), WORKSHEET_LIMITS.title);
  });

  it("caps the worksheet description at WORKSHEET_LIMITS.description", () => {
    assert.equal(
      ruleCap(/get\('description', ''\)\.size\(\) <= (\d+)/),
      WORKSHEET_LIMITS.description,
    );
  });

  it("caps the items array at WORKSHEET_LIMITS.maxItems, on the worksheet and the copy", () => {
    // The same number twice, on two documents: the library worksheet and the
    // circulation's frozen copy of it. A copy that could hold more items than
    // the thing it was copied from is a worksheet nobody could edit back.
    const caps = [...WORKSHEET_RULES.matchAll(/items\.size\(\) <= (\d+)/g)].map((m) => Number(m[1]));
    assert.equal(caps.length, 3, "expected the cap on worksheet create, worksheet update and the circulation copy");
    for (const cap of caps) assert.equal(cap, WORKSHEET_LIMITS.maxItems);
  });

  it("caps a folder name at WORKSHEET_LIMITS.folderName", () => {
    assert.equal(ruleCap(/name\.size\(\) <= (\d+)/), WORKSHEET_LIMITS.folderName);
  });

  it("caps overall feedback at CIRCULATION_LIMITS.overall", () => {
    assert.equal(ruleCap(/get\('overall', ''\)\.size\(\) <= (\d+)/), CIRCULATION_LIMITS.overall);
  });

  it("caps the answers and perQuestion maps at one entry per item a worksheet may hold", () => {
    // Both maps are keyed by question id, so the honest ceiling for either is
    // the number of items a worksheet may carry. Written as the same constant
    // rather than a literal so raising maxItems cannot leave a response unable
    // to hold an answer to every question on it.
    assert.equal(ruleCap(/get\('answers', \{\}\)\.size\(\) <= (\d+)/), WORKSHEET_LIMITS.maxItems);
    assert.equal(ruleCap(/get\('perQuestion', \{\}\)\.size\(\) <= (\d+)/), WORKSHEET_LIMITS.maxItems);
  });

  it("keeps `private` as a bare comparison, because a list depends on it", () => {
    // Not a number, but the same class of two-layer claim and the one with the
    // longest history in this repo: written as `.get('private', false)` the
    // clause is not one the query analyser can discharge, so EVERY committee
    // library listen would be refused, filtered or not. That is #261 exactly.
    assert.match(WORKSHEET_RULES, /resource\.data\.private == false/);
    assert.doesNotMatch(WORKSHEET_RULES, /get\('private',/);
  });

  it("pins the review author to the writer", () => {
    // A review is the record of a judgement about a person, and the returned
    // feedback quotes the name back to them. An unpinned stamp would let one
    // staff member sign a colleague's name to it.
    assert.match(
      WORKSHEET_RULES,
      /get\('updatedByUid', ''\) == request\.auth\.uid/,
    );
  });
});
