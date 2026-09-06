/**
 * The pure helpers behind the respond page: page navigation, the per-page
 * answered state, whether a cleared answer should be removed, which questions
 * the autosave still owes the document, what a save failure says, and active
 * time as a sentence.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * Every function under test is a small decision the page makes dozens of times
 * a session, and each one fails in a way a rendering test would not notice.
 *
 *  1. **The jump lands on the earliest page with a problem, not on the page
 *     holding the first problem in the list.** `validateSubmission` walks the
 *     items in document order, so the two usually agree, and they stop
 *     agreeing the moment staff reorder the questions mid-flight. Getting it
 *     wrong sends somebody to a page AFTER the mistake they were sent to fix.
 *  2. **A cleared box removes its key, it does not store an empty answer.**
 *     Both read back as unanswered on screen, so nothing looks wrong; what is
 *     wrong is the document, which then carries empty answers the CSV export
 *     prints as columns and a reviewer reads as "they wrote something and
 *     deleted it".
 *  3. **A page index is clamped on every render, not only on navigation.** The
 *     circulation's copy of the questions can SHRINK under somebody who has it
 *     open, and a stored index past the end renders a page with a Next button
 *     and nothing above it.
 *  4. **Active time is rounded, and says so.** The number is accumulated in
 *     30-second ticks, so "12 minutes 30 seconds" would claim a precision it
 *     does not have, and "0 minutes" for a first glance reads as a bug.
 *  5. **The autosave claims its questions before the write, not after it.**
 *     This is the one nothing on screen can show. A write that clears the
 *     pending set on the way back deletes the re-add made by a push that
 *     arrived while it was in flight, and the newer text is then in no
 *     document and in no queue while the debouncer reports "saved" and the
 *     green tick appears. The simulation below drives the same queue, the same
 *     drain loop and the real `claimPending` / `restorePending`, so the lost
 *     update is a failing test rather than a report from somebody who typed a
 *     paragraph twice.
 *  6. **A save failure says what to do, not what the SDK called it.** Every
 *     write in the answering path is client-direct, so the raw text is
 *     "Missing or insufficient permissions.", which tells a recipient who has
 *     just lost a paragraph nothing about what to do with it.
 *
 * ## Why the loader dance
 *
 * Same as tests/worksheets-model.test.mjs and tests/form-question-limits.test.mjs:
 * this repo's Node predates the v22.18 that strips TypeScript natively, so the
 * module graph is transpiled in memory with the `typescript` devDependency
 * `npx tsc --noEmit` already uses. The transpile path is taken unconditionally
 * rather than as a fallback, so the behaviour is identical on every Node the
 * team runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const HELPERS_MODULE = join(SRC, "features", "worksheets", "respond", "respondHelpers.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. `respondHelpers.ts` imports the
 * worksheet model, which pulls in `newsletterBlocks.ts` for the block
 * sanitiser, which pulls in `marked`. No helper here reaches a block, and
 * stubbing it keeps this file honest about what it is testing.
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
  claimPending,
  clampPageIndex,
  firstPageWithProblem,
  formatActiveTime,
  pageState,
  restorePending,
  saveErrorSentence,
  shouldRemoveAnswer,
} = await loadTs(HELPERS_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function question(id, overrides = {}) {
  return {
    kind: "question",
    id,
    type: "shortText",
    title: `Question ${id}`,
    body: [],
    required: false,
    ...overrides,
  };
}

function section(id) {
  return { kind: "section", id, heading: `Section ${id}`, body: [] };
}

function text(value) {
  return { type: "text", text: value };
}

/** Three pages: [q1, q2], [section, q3], [q4]. */
const PAGES = [
  [question("q1"), question("q2")],
  [section("s1"), question("q3")],
  [question("q4")],
];

// ---------------------------------------------------------------------------
// 1. Page navigation
// ---------------------------------------------------------------------------

describe("clampPageIndex", () => {
  it("holds an index inside the pages that exist", () => {
    assert.equal(clampPageIndex(5, 3), 2);
    assert.equal(clampPageIndex(1, 3), 1);
  });

  it("clamps a negative index to the first page", () => {
    assert.equal(clampPageIndex(-4, 3), 0);
  });

  it("returns 0 for a worksheet with no pages, which is the empty state", () => {
    assert.equal(clampPageIndex(2, 0), 0);
  });

  it("survives a value that is not a number", () => {
    assert.equal(clampPageIndex(Number.NaN, 3), 0);
  });
});

describe("firstPageWithProblem", () => {
  it("returns -1 when nothing is wrong", () => {
    assert.equal(firstPageWithProblem(PAGES, []), -1);
  });

  it("returns the earliest page, not the page of the first problem listed", () => {
    // The list is deliberately out of page order, which is what a mid-flight
    // reorder produces. The jump has to land on page 0 either way.
    const problems = [
      { questionId: "q4", message: "This question needs an answer." },
      { questionId: "q1", message: "This question needs an answer." },
    ];
    assert.equal(firstPageWithProblem(PAGES, problems), 0);
  });

  it("returns -1 when the problem names a question no page holds", () => {
    // A question deleted from the circulation's copy while somebody had it
    // open. There is no page to send them to, and pretending otherwise would
    // put them on page one with nothing marked.
    const problems = [{ questionId: "deleted", message: "This question needs an answer." }];
    assert.equal(firstPageWithProblem(PAGES, problems), -1);
  });
});

// ---------------------------------------------------------------------------
// 2. What one page looks like
// ---------------------------------------------------------------------------

describe("pageState", () => {
  it("counts only the questions on that page", () => {
    const answers = { q1: text("yes"), q4: text("also yes") };
    assert.deepEqual(pageState(PAGES[0], answers), {
      answered: 1,
      total: 2,
      requiredOutstanding: 0,
    });
  });

  it("does not count a section as something to answer", () => {
    assert.deepEqual(pageState(PAGES[1], {}), {
      answered: 0,
      total: 1,
      requiredOutstanding: 0,
    });
  });

  it("reports required questions that are still empty", () => {
    const page = [question("a", { required: true }), question("b", { required: true })];
    const state = pageState(page, { a: text("done") });
    assert.equal(state.answered, 1);
    assert.equal(state.requiredOutstanding, 1);
  });

  it("treats whitespace in a text box as no answer at all", () => {
    const page = [question("a", { required: true })];
    assert.deepEqual(pageState(page, { a: text("   ") }), {
      answered: 0,
      total: 1,
      requiredOutstanding: 1,
    });
  });

  it("calls a page with no questions complete", () => {
    assert.deepEqual(pageState([section("s2")], {}), {
      answered: 0,
      total: 0,
      requiredOutstanding: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Storing an answer, or removing its key
// ---------------------------------------------------------------------------

describe("shouldRemoveAnswer", () => {
  it("removes the key when there is no answer at all", () => {
    assert.equal(shouldRemoveAnswer(undefined), true);
    assert.equal(shouldRemoveAnswer(null), true);
  });

  it("removes the key for every shape of empty answer", () => {
    assert.equal(shouldRemoveAnswer(text("")), true);
    assert.equal(shouldRemoveAnswer(text("  \n ")), true);
    assert.equal(shouldRemoveAnswer({ type: "choice", optionId: "" }), true);
    assert.equal(shouldRemoveAnswer({ type: "choices", optionIds: [] }), true);
    assert.equal(shouldRemoveAnswer({ type: "images", images: [] }), true);
    // Zero is how a cleared rating comes back from the widget.
    assert.equal(shouldRemoveAnswer({ type: "rating", value: 0 }), true);
  });

  it("keeps an answer somebody actually gave", () => {
    assert.equal(shouldRemoveAnswer(text("a real answer")), false);
    assert.equal(shouldRemoveAnswer({ type: "choice", optionId: "o1" }), false);
    assert.equal(shouldRemoveAnswer({ type: "choices", optionIds: ["o1"] }), false);
    assert.equal(shouldRemoveAnswer({ type: "rating", value: 1 }), false);
    assert.equal(
      shouldRemoveAnswer({
        type: "images",
        images: [{ url: "https://example.test/a.png", storagePath: "p" }],
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. What the autosave still owes the document
// ---------------------------------------------------------------------------

describe("claimPending and restorePending", () => {
  it("takes everything out of the set and hands it back to the caller", () => {
    const pending = new Set(["q1", "q2"]);
    assert.deepEqual(claimPending(pending), ["q1", "q2"]);
    assert.equal(pending.size, 0);
  });

  it("claims nothing from an empty set, which is how a write skips itself", () => {
    const pending = new Set();
    assert.deepEqual(claimPending(pending), []);
  });

  it("keeps a question added while the write was in flight when that write fails", () => {
    // The claim goes out, the recipient carries on typing (the push re-adds
    // the same question), and then the write is refused. The question must be
    // pending exactly once afterwards: twice is impossible in a Set, and zero
    // is the lost update this pair exists to prevent.
    const pending = new Set(["q1"]);
    const claimed = claimPending(pending);
    pending.add("q1");
    restorePending(pending, claimed);
    assert.deepEqual([...pending], ["q1"]);
  });
});

/**
 * The autosave reduced to the three parts that can lose an answer between
 * them: the debouncer's one-slot queue, the drain loop that empties it one
 * write at a time, and the pending set `claimPending` / `restorePending` own.
 *
 * The queue and the loop are transcribed from `src/hooks/useDebouncedWrite.ts`
 * (`push` sets the slot, `drain` re-reads the slot after every write so a push
 * that lands mid-flight joins the running drain rather than starting a second
 * one). The pending set is the REAL code: this file cannot import the React
 * hook, but the decision under test lives in the two functions above, and
 * driving them through the same order the hook does is what turns "the ids are
 * claimed first" from a comment into a check.
 */
function makeAutosave() {
  const stored = {};
  const pending = new Set();
  let slot = null;
  let lastValue = null;
  let draining = null;
  let state = "idle";
  let refuseNext = false;

  async function write(next) {
    const ids = claimPending(pending);
    if (ids.length === 0) return;
    // Stands in for the await on updateDoc: everything queued from here until
    // the write settles is a push that arrived while it was in flight.
    await Promise.resolve();
    if (refuseNext) {
      refuseNext = false;
      restorePending(pending, ids);
      throw new Error("Missing or insufficient permissions.");
    }
    for (const id of ids) stored[id] = next[id];
  }

  function drain() {
    if (draining) return draining;
    const run = (async () => {
      while (slot) {
        const { value } = slot;
        slot = null;
        try {
          await write(value);
          state = "saved";
        } catch {
          state = "error";
        }
      }
    })();
    draining = run;
    void run.finally(() => {
      if (draining === run) draining = null;
    });
    return run;
  }

  return {
    stored,
    get state() {
      return state;
    },
    pendingIds: () => [...pending],
    refuseNext() {
      refuseNext = true;
    },
    /** One edit: the question is owed, and the newest map waits in the slot. */
    type(answers, questionId) {
      pending.add(questionId);
      lastValue = answers;
      slot = { value: answers };
    },
    /** The debounce timer firing. */
    tick: () => drain(),
    /** The Save button: re-queue anything owed, then write it. */
    save() {
      if (pending.size > 0 && lastValue) slot = { value: lastValue };
      return drain();
    },
  };
}

describe("the autosave queue, driven the way the page drives it", () => {
  it("writes an answer edited while the previous write was in flight", async () => {
    const autosave = makeAutosave();
    autosave.type({ q1: "first draft" }, "q1");
    const inFlight = autosave.tick();
    // The pause-then-carry-on-typing rhythm of a long answer. This is the
    // whole bug: claiming the ids after the await instead of before it would
    // delete this re-add, and the newer text would be written nowhere while
    // the page said Saved.
    autosave.type({ q1: "first draft, then more" }, "q1");
    await inFlight;
    await autosave.save();
    assert.equal(autosave.stored.q1, "first draft, then more");
    assert.deepEqual(autosave.pendingIds(), []);
    assert.equal(autosave.state, "saved");
  });

  it("carries a refused write's questions into the next Save", async () => {
    const autosave = makeAutosave();
    autosave.type({ q1: "a real answer" }, "q1");
    autosave.refuseNext();
    await autosave.tick();
    assert.equal(autosave.state, "error");
    assert.equal(autosave.stored.q1, undefined);
    assert.deepEqual(autosave.pendingIds(), ["q1"]);

    await autosave.save();
    assert.equal(autosave.stored.q1, "a real answer");
    assert.deepEqual(autosave.pendingIds(), []);
    assert.equal(autosave.state, "saved");
  });
});

// ---------------------------------------------------------------------------
// 5. What a failed save says
// ---------------------------------------------------------------------------

describe("saveErrorSentence", () => {
  it("tells somebody locked out to copy their words and reload", () => {
    const err = Object.assign(new Error("Missing or insufficient permissions."), {
      code: "permission-denied",
    });
    const sentence = saveErrorSentence(err);
    assert.match(sentence, /no longer taking changes/);
    assert.match(sentence, /reload the page/);
    // The SDK's own words never lead: the action does.
    assert.doesNotMatch(sentence, /insufficient permissions/);
  });

  it("tells somebody offline to keep the tab open", () => {
    const err = Object.assign(new Error("Failed to get document because the client is offline."), {
      code: "unavailable",
    });
    assert.match(saveErrorSentence(err), /back online/);
  });

  it("leads with the action and keeps the raw message for an unknown failure", () => {
    const sentence = saveErrorSentence(new Error("something nobody has seen"));
    assert.match(sentence, /^Your last change is not stored\./);
    assert.match(sentence, /\(something nobody has seen\)$/);
  });

  it("says something useful when there is no error object at all", () => {
    assert.match(saveErrorSentence(null), /^Your last change is not stored\./);
    assert.match(saveErrorSentence(undefined), /press Save to try again\.$/);
  });
});

// ---------------------------------------------------------------------------
// 6. Active time
// ---------------------------------------------------------------------------

describe("formatActiveTime", () => {
  it("says under a minute rather than rounding to zero", () => {
    assert.equal(formatActiveTime(0), "under a minute");
    assert.equal(formatActiveTime(30_000), "under a minute");
  });

  it("counts whole minutes, singular and plural", () => {
    assert.equal(formatActiveTime(60_000), "1 minute");
    assert.equal(formatActiveTime(12 * 60_000), "12 minutes");
  });

  it("counts hours, with and without minutes after them", () => {
    assert.equal(formatActiveTime(60 * 60_000), "1 hour");
    assert.equal(formatActiveTime(65 * 60_000), "1 hour 5 minutes");
    assert.equal(formatActiveTime(120 * 60_000), "2 hours");
  });

  it("carries a rounded 60 minutes into the hour instead of printing it", () => {
    // 1 hour 59 minutes 40 seconds rounds to 60 minutes, which must read as
    // two hours and never as "1 hour 60 minutes".
    assert.equal(formatActiveTime(60 * 60_000 + 59 * 60_000 + 40_000), "2 hours");
  });

  it("survives a stored value that is not a number", () => {
    assert.equal(formatActiveTime(Number.NaN), "under a minute");
  });
});
