/**
 * Unit tests for PER-QUESTION CHARACTER LIMITS and help text on the shared
 * `FormQuestion` type.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * `FormQuestion` is shared: the same type backs an event's RSVP form and a
 * course application form, and admissions is about to become a third caller
 * with much longer answers than a pizza order. Three properties have to hold
 * at once, and each one is a decision rather than an obvious consequence.
 *
 *  1. **Silence for existing forms.** Every signup form authored before
 *     `maxLength` existed is stored with no such key. `answerMaxLength` falls
 *     back to 500, so those forms refuse at exactly the length they always
 *     did. The 500 / 501 pair below is the regression pin: it is the whole
 *     reason the field is optional rather than required with a default written
 *     into every document.
 *
 *  2. **A draft may be unfinished.** A saved-but-unsubmitted application is
 *     half written by definition, so `enforceRequired: false` lets a blank
 *     required question through. Nothing else relaxes: an answer over its
 *     limit, an unknown option and a malformed shape are still refused on a
 *     draft, so a draft can never hold a value the submit path would then have
 *     to reject. The default stays true, which is what every submit path wants.
 *
 *  3. **A bad limit names the question, it does not delete it.**
 *     `sanitizeSignupForm` is `raw.filter(isValidQuestion)`, so range-checking
 *     inside that predicate would make an author who typed 5000 lose the whole
 *     question with no message. The check lives in `validateQuestionLimits`,
 *     which the saving route calls to answer 400 with the question named.
 *     `sanitizeSignupForm` clamps instead of dropping, so a write that never
 *     crossed a route still cannot store an unbounded cap.
 *
 * ## Why the loader dance
 *
 * Same root cause as `course-window.test.mjs`: this repo's Node predates the
 * v22.18 that strips TypeScript natively, so the module graph is transpiled in
 * memory with the `typescript` devDependency `npx tsc --noEmit` already uses.
 * The transpile path is taken unconditionally rather than as a fallback, so the
 * behaviour is identical on every Node the team runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const VALIDATE_MODULE = join(SRC, "lib", "events", "validateAnswers.ts");
const EVENTS_MODULE = join(SRC, "lib", "firestore", "events.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. `events.ts` pulls in
 * `newsletterBlocks.ts` for the block sanitiser, which pulls in `marked` to
 * render rich text. None of that is reached by a form question, and stubbing it
 * keeps this file honest about what it is testing.
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

const { validateAnswers } = await loadTs(VALIDATE_MODULE);
const {
  answerMaxLength,
  DEFAULT_ANSWER_MAX_LENGTH,
  QUESTION_HELP_TEXT_MAX,
  QUESTION_MAX_LENGTH_MAX,
  QUESTION_MAX_LENGTH_MIN,
  sanitizeSignupForm,
  validateQuestionLimits,
} = await loadTs(EVENTS_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const chars = (n) => "a".repeat(n);

function shortText(overrides = {}) {
  return { id: "q1", type: "shortText", label: "Your dietary needs", required: false, ...overrides };
}

function longText(overrides = {}) {
  return { id: "q2", type: "longText", label: "Why this course?", required: false, ...overrides };
}

function multiOther(overrides = {}) {
  return {
    id: "q3",
    type: "multiSelect",
    label: "Toppings",
    required: false,
    options: ["Cheese", "Olives"],
    allowOther: true,
    ...overrides,
  };
}

function dietary(overrides = {}) {
  return {
    id: "q4",
    type: "dietaryAllergies",
    label: "Any allergies?",
    required: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Existing forms do not change behaviour
// ---------------------------------------------------------------------------

test("the default cap is 500 and a question with no maxLength uses it", () => {
  assert.equal(DEFAULT_ANSWER_MAX_LENGTH, 500);
  assert.equal(answerMaxLength(shortText()), 500);
  assert.equal(answerMaxLength(longText()), 500);
});

test("an event RSVP question with no maxLength still accepts 500 characters", () => {
  const out = validateAnswers([shortText()], { q1: chars(500) });
  assert.ok("answers" in out, out.error);
  assert.equal(out.answers.q1.length, 500);
});

test("an event RSVP question with no maxLength still refuses at 501 characters", () => {
  // The regression pin. Every form authored before per-question limits existed
  // is stored with no maxLength key, so this is the sentence those forms have
  // always produced and must keep producing.
  const out = validateAnswers([shortText()], { q1: chars(501) });
  assert.ok("error" in out);
  assert.match(out.error, /too long \(max 500 chars\)/);
  assert.equal(out.questionId, "q1");
});

test("the same 501 refusal holds for long text and for an Other box", () => {
  const long = validateAnswers([longText()], { q2: chars(501) });
  assert.ok("error" in long);
  assert.match(long.error, /max 500 chars/);

  const other = validateAnswers([multiOther()], {
    q3: { checked: [], other: chars(501) },
  });
  assert.ok("error" in other);
  assert.match(other.error, /other-field is too long \(max 500\)/);

  const diet = validateAnswers([dietary()], {
    q4: { checked: [], other: chars(501) },
  });
  assert.ok("error" in diet);
  assert.match(diet.error, /other-field is too long \(max 500\)/);
});

// ---------------------------------------------------------------------------
// 2. An authored limit replaces the default, in both directions
// ---------------------------------------------------------------------------

test("a question authored with maxLength 1500 accepts 1200 and refuses 1501", () => {
  const q = [longText({ maxLength: 1500 })];
  const ok = validateAnswers(q, { q2: chars(1200) });
  assert.ok("answers" in ok, ok.error);
  assert.equal(ok.answers.q2.length, 1200);

  const tooLong = validateAnswers(q, { q2: chars(1501) });
  assert.ok("error" in tooLong);
  assert.match(tooLong.error, /max 1500 chars/);
});

test("a limit tighter than the default is enforced too", () => {
  const out = validateAnswers([shortText({ maxLength: 40 })], { q1: chars(41) });
  assert.ok("error" in out);
  assert.match(out.error, /max 40 chars/);
});

test("an Other box is capped by its own question's limit", () => {
  const q = [multiOther({ maxLength: 80 })];
  const ok = validateAnswers(q, { q3: { checked: ["Olives"], other: chars(80) } });
  assert.ok("answers" in ok, ok.error);

  const over = validateAnswers(q, { q3: { checked: [], other: chars(81) } });
  assert.ok("error" in over);
  assert.match(over.error, /other-field is too long \(max 80\)/);
});

// ---------------------------------------------------------------------------
// 3. enforceRequired: the draft-save escape hatch
// ---------------------------------------------------------------------------

test("by default an unanswered required question is refused", () => {
  const out = validateAnswers([longText({ required: true })], {});
  assert.ok("error" in out);
  assert.match(out.error, /is required/);
  assert.equal(out.questionId, "q2");
});

test("an explicit enforceRequired: true is still a refusal", () => {
  const out = validateAnswers([longText({ required: true })], {}, { enforceRequired: true });
  assert.ok("error" in out);
  assert.match(out.error, /is required/);
});

test("enforceRequired: false lets an unanswered required question through", () => {
  // What makes a server-side draft possible at all: an applicant saves what
  // they have written so far, required questions included.
  const out = validateAnswers([longText({ required: true })], {}, { enforceRequired: false });
  assert.ok("answers" in out, out.error);
  assert.deepEqual(out.answers, {});
});

test("enforceRequired: false relaxes required across every question type", () => {
  const questions = [
    shortText({ required: true }),
    longText({ required: true }),
    { id: "q5", type: "singleSelect", label: "Pick", required: true, options: ["A", "B"] },
    multiOther({ required: true }),
    { id: "q6", type: "yesNo", label: "Coming?", required: true },
    dietary({ required: true }),
  ];
  const out = validateAnswers(questions, {}, { enforceRequired: false });
  assert.ok("answers" in out, out.error);
  assert.deepEqual(out.answers, {});
});

test("a draft still refuses an over-long answer, an unknown option and a bad shape", () => {
  // The relaxation is scoped to "not finished yet". A draft that could hold a
  // value the submit path would reject would only move the failure later.
  const over = validateAnswers([longText({ required: true })], { q2: chars(501) }, {
    enforceRequired: false,
  });
  assert.ok("error" in over);
  assert.match(over.error, /max 500 chars/);

  const unknown = validateAnswers(
    [{ id: "q5", type: "singleSelect", label: "Pick", required: true, options: ["A", "B"] }],
    { q5: "C" },
    { enforceRequired: false },
  );
  assert.ok("error" in unknown);
  assert.match(unknown.error, /unknown option/);

  const shape = validateAnswers([multiOther({ required: true })], { q3: ["Cheese"] }, {
    enforceRequired: false,
  });
  assert.ok("error" in shape);
  assert.match(shape.error, /invalid shape/);
});

// ---------------------------------------------------------------------------
// 4. validateQuestionLimits names the offending question
// ---------------------------------------------------------------------------

test("a well-formed form passes the limit check", () => {
  assert.equal(
    validateQuestionLimits([shortText({ maxLength: 1 }), longText({ maxLength: 4000 })]),
    null,
  );
  assert.equal(validateQuestionLimits([shortText(), longText()]), null);
  assert.equal(QUESTION_MAX_LENGTH_MIN, 1);
  assert.equal(QUESTION_MAX_LENGTH_MAX, 4000);
});

test("a limit over the maximum is reported by question label, not silently dropped", () => {
  const problem = validateQuestionLimits([
    shortText(),
    longText({ label: "Your motivation", maxLength: 5000 }),
  ]);
  assert.ok(problem);
  assert.match(problem.error, /"Your motivation"/);
  assert.match(problem.error, /5000/);
  assert.match(problem.error, /between 1 and 4000/);
  assert.equal(problem.questionId, "q2");
});

test("a limit under the minimum is reported the same way", () => {
  const problem = validateQuestionLimits([shortText({ maxLength: 0 })]);
  assert.ok(problem);
  assert.match(problem.error, /"Your dietary needs"/);
});

test("an unlabelled question is named by its position", () => {
  const problem = validateQuestionLimits([shortText({ label: "   ", maxLength: 9000 })]);
  assert.ok(problem);
  assert.match(problem.error, /Question 1/);
});

test("a fractional limit is reported rather than rounded behind the author's back", () => {
  const problem = validateQuestionLimits([shortText({ maxLength: 12.5 })]);
  assert.ok(problem);
  assert.match(problem.error, /whole number/);
});

test("over-long help text is reported with the overshoot", () => {
  const problem = validateQuestionLimits([
    shortText({ helpText: chars(QUESTION_HELP_TEXT_MAX + 4) }),
  ]);
  assert.ok(problem);
  assert.match(problem.error, /help text 4 characters over the limit of 300/);
});

// ---------------------------------------------------------------------------
// 5. sanitizeSignupForm clamps, and never deletes the question
// ---------------------------------------------------------------------------

test("an out-of-range limit is clamped, not dropped with its question", () => {
  // The failure this guards: range-checking inside `isValidQuestion` would make
  // `raw.filter(isValidQuestion)` delete the question outright, so an author who
  // typed 5000 would watch their question vanish with no message.
  const [q] = sanitizeSignupForm([longText({ maxLength: 5000 })]);
  assert.ok(q, "the question survived");
  assert.equal(q.id, "q2");
  assert.equal(q.maxLength, 4000);

  const [tiny] = sanitizeSignupForm([longText({ maxLength: -3 })]);
  assert.equal(tiny.maxLength, 1);
});

test("clampLimits: false keeps the authored number so a route can quote it back", () => {
  const [q] = sanitizeSignupForm([longText({ maxLength: 5000 })], { clampLimits: false });
  assert.equal(q.maxLength, 5000);
  const problem = validateQuestionLimits([q]);
  assert.ok(problem);
  assert.match(problem.error, /5000/);
});

test("a non-numeric limit and blank help text leave no key behind at all", () => {
  // Not `undefined`: an explicit undefined nested in an array is refused
  // outright by a client-direct Firestore write, which is how a run's
  // application form is saved.
  const [q] = sanitizeSignupForm([longText({ maxLength: "lots", helpText: "   " })]);
  assert.equal(Object.hasOwn(q, "maxLength"), false);
  assert.equal(Object.hasOwn(q, "helpText"), false);
});

test("help text is trimmed and capped at 300 characters", () => {
  const [q] = sanitizeSignupForm([shortText({ helpText: `  ${chars(400)}  ` })]);
  assert.equal(q.helpText.length, QUESTION_HELP_TEXT_MAX);
});

test("a stored over-limit cap cannot outrun the clamp on the read path", () => {
  // A form written straight to Firestore, bypassing every route, still cannot
  // authorise an unbounded answer once it is read back through the normaliser.
  const [q] = sanitizeSignupForm([longText({ maxLength: 1000000 })]);
  const out = validateAnswers([q], { q2: chars(4001) });
  assert.ok("error" in out);
  assert.match(out.error, /max 4000 chars/);
});
