/**
 * Unit tests for the pure list operations behind the worksheet editor
 * (`src/features/worksheets/editor/itemOps.ts`).
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * The editor is controlled: it holds no copy of `items`, so every interaction
 * is one of these functions and nothing else. Four properties have to hold,
 * and each one is a decision rather than an obvious consequence.
 *
 *  1. **Reorder by arrow and reorder by drag are DIFFERENT operations.**
 *     `moveItem` swaps with a neighbour; `reorderItems` lifts an item out and
 *     puts it back at an index, shuffling everything between. For a
 *     single-step move the two agree, which is exactly why implementing the
 *     drag as a swap looks correct until somebody drags a row four places and
 *     the row that was there lands where theirs came from.
 *
 *  2. **Nothing mutates.** React compares by identity, so an in-place splice
 *     on the prop array is the class of bug where the data is right and the
 *     screen is a move behind. Every case below asserts the input array is
 *     untouched, and the out-of-range cases assert the SAME reference comes
 *     back, so the up arrow on the first row cannot dirty an autosave.
 *
 *  3. **Duplicate mints ids all the way down.** Option ids key answers per
 *     question, so two questions sharing an option id is a trap set for
 *     whoever later writes the poll aggregate. The copy also has to land
 *     directly under its original rather than at the end of the list.
 *
 *  4. **A type change keeps the author's words and resets the answer shape.**
 *     Title, body and `required` describe the thing being asked; options,
 *     limits and scales describe how it is answered. The reset comes from
 *     `emptyQuestion`, which is the one place that knows a poll needs two
 *     blank options, so this file pins that it is reached rather than
 *     hand-rolled.
 *
 * ## Why the loader dance
 *
 * Same root cause as `form-question-limits.test.mjs`: this repo's Node
 * predates the v22.18 that strips TypeScript natively, so the module graph is
 * transpiled in memory with the `typescript` devDependency `npx tsc --noEmit`
 * already uses. The transpile path is taken unconditionally rather than as a
 * fallback, so the behaviour is identical on every Node the team runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const ITEM_OPS_MODULE = join(SRC, "features", "worksheets", "editor", "itemOps.ts");
const WORKSHEETS_MODULE = join(SRC, "lib", "firestore", "worksheets.ts");

/** Every module specifier in transpiled output, in either quote style. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module. `worksheets.ts` pulls in
 * `newsletterBlocks.ts` for the block sanitiser, which pulls in `marked` to
 * render legacy markdown. No item operation touches a block's contents, and
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
      throw new Error("the `typescript` devDependency is not installed. Run `npm install`.", {
        cause: err,
      });
    }
  }
  return import(await transpileToDataUrl(file));
}

const {
  changeQuestionType,
  duplicateItemAt,
  insertItemAt,
  moveItem,
  problemsByItem,
  removeItemAt,
  reorderItems,
} = await loadTs(ITEM_OPS_MODULE);

const { emptyPageBreak, emptyQuestion, emptySection } = await loadTs(WORKSHEETS_MODULE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A question with a fixed id, so an assertion can name a row. */
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

function ids(items) {
  return items.map((item) => item.id);
}

const FOUR = [question("a"), question("b"), question("c"), question("d")];

// ---------------------------------------------------------------------------
// moveItem: the arrow buttons
// ---------------------------------------------------------------------------

test("moveItem swaps an item with the neighbour in that direction", () => {
  assert.deepEqual(ids(moveItem(FOUR, 1, -1)), ["b", "a", "c", "d"]);
  assert.deepEqual(ids(moveItem(FOUR, 1, 1)), ["a", "c", "b", "d"]);
});

test("moveItem off either end returns the SAME array, so no autosave is dirtied", () => {
  assert.equal(moveItem(FOUR, 0, -1), FOUR);
  assert.equal(moveItem(FOUR, FOUR.length - 1, 1), FOUR);
  assert.equal(moveItem(FOUR, 99, -1), FOUR);
});

test("moveItem leaves the array it was given untouched", () => {
  const before = ids(FOUR);
  moveItem(FOUR, 2, -1);
  assert.deepEqual(ids(FOUR), before);
});

// ---------------------------------------------------------------------------
// reorderItems: the drag handle
// ---------------------------------------------------------------------------

test("reorderItems shuffles the rows between, it does not swap the two ends", () => {
  // The whole point of the separate function: a swap would give d,b,c,a.
  assert.deepEqual(ids(reorderItems(FOUR, 0, 3)), ["b", "c", "d", "a"]);
  assert.deepEqual(ids(reorderItems(FOUR, 3, 0)), ["d", "a", "b", "c"]);
});

test("reorderItems agrees with moveItem for a single-step move", () => {
  assert.deepEqual(ids(reorderItems(FOUR, 1, 2)), ids(moveItem(FOUR, 1, 1)));
});

test("reorderItems returns the SAME array for a no-op or an out-of-range drop", () => {
  assert.equal(reorderItems(FOUR, 2, 2), FOUR);
  assert.equal(reorderItems(FOUR, -1, 2), FOUR);
  assert.equal(reorderItems(FOUR, 1, 9), FOUR);
});

// ---------------------------------------------------------------------------
// insertItemAt and removeItemAt
// ---------------------------------------------------------------------------

test("insertItemAt puts the new item AFTER the index it was given", () => {
  const next = insertItemAt(FOUR, question("new"), 1);
  assert.deepEqual(ids(next), ["a", "b", "new", "c", "d"]);
});

test("insertItemAt with a null index appends, which is what the end menu passes", () => {
  assert.deepEqual(ids(insertItemAt(FOUR, question("new"), null)), ["a", "b", "c", "d", "new"]);
  assert.deepEqual(ids(insertItemAt([], question("new"), null)), ["new"]);
});

test("removeItemAt drops one row and ignores an index that is not in the list", () => {
  assert.deepEqual(ids(removeItemAt(FOUR, 2)), ["a", "b", "d"]);
  assert.equal(removeItemAt(FOUR, 9), FOUR);
  assert.deepEqual(ids(FOUR), ["a", "b", "c", "d"]);
});

// ---------------------------------------------------------------------------
// duplicateItemAt
// ---------------------------------------------------------------------------

test("duplicateItemAt lands the copy directly under its original", () => {
  const next = duplicateItemAt(FOUR, 1);
  assert.equal(next.length, 5);
  assert.equal(next[1].id, "b");
  assert.equal(next[2].title, "Question b");
});

test("duplicateItemAt mints a fresh id for the copy", () => {
  const next = duplicateItemAt(FOUR, 1);
  assert.notEqual(next[2].id, "b");
  assert.match(next[2].id, /^q_/);
});

test("duplicateItemAt mints fresh OPTION ids, so two questions never share one", () => {
  const poll = emptyQuestion("poll");
  const next = duplicateItemAt([poll], 0);
  const original = next[0].options.map((o) => o.id);
  const copy = next[1].options.map((o) => o.id);
  assert.equal(copy.length, original.length);
  for (const id of copy) assert.equal(original.includes(id), false);
  // The poll's own settings still come across.
  assert.equal(next[1].poll.resultsVisibility, poll.poll.resultsVisibility);
});

test("duplicateItemAt copies a section and a page break too", () => {
  const items = [emptySection(), emptyPageBreak()];
  const withSection = duplicateItemAt(items, 0);
  assert.equal(withSection[1].kind, "section");
  assert.notEqual(withSection[1].id, items[0].id);
  const withBreak = duplicateItemAt(items, 1);
  assert.equal(withBreak[2].kind, "pageBreak");
  assert.notEqual(withBreak[2].id, items[1].id);
});

// ---------------------------------------------------------------------------
// changeQuestionType
// ---------------------------------------------------------------------------

test("changeQuestionType keeps the author's words and the item's identity", () => {
  const before = question("a", {
    type: "shortText",
    title: "How did the term go?",
    body: [{ id: "b1", type: "richText", html: "<p>Be honest.</p>" }],
    required: true,
    limit: { unit: "words", max: 200 },
  });
  const after = changeQuestionType(before, "rating");
  assert.equal(after.id, "a");
  assert.equal(after.title, "How did the term go?");
  assert.deepEqual(after.body, before.body);
  assert.equal(after.required, true);
});

test("changeQuestionType resets the answer shape through emptyQuestion", () => {
  const before = question("a", { type: "singleChoice", options: [{ id: "o1", label: "Yes" }] });
  const after = changeQuestionType(before, "rating");
  assert.equal(after.type, "rating");
  assert.equal(after.options, undefined);
  // The scale comes from `emptyQuestion`, not from anything written here.
  assert.deepEqual(after.rating, emptyQuestion("rating").rating);
});

test("changeQuestionType drops a text limit that the new type cannot honour", () => {
  const before = question("a", { limit: { unit: "characters", max: 500 } });
  assert.equal(changeQuestionType(before, "imageUpload").limit, undefined);
});

test("changeQuestionType to the same type returns the question untouched", () => {
  const before = question("a", { type: "longText", limit: { unit: "words", max: 300 } });
  assert.equal(changeQuestionType(before, "longText"), before);
});

// ---------------------------------------------------------------------------
// problemsByItem
// ---------------------------------------------------------------------------

test("problemsByItem groups every message under the item it names, in order", () => {
  const map = problemsByItem([
    { itemId: "a", message: "This question needs a title." },
    { itemId: "b", message: "Every option needs a label." },
    { itemId: "a", message: "This question needs at least 2 options." },
  ]);
  assert.deepEqual(map.get("a"), [
    "This question needs a title.",
    "This question needs at least 2 options.",
  ]);
  assert.deepEqual(map.get("b"), ["Every option needs a label."]);
  assert.equal(map.get("c"), undefined);
});

test("problemsByItem keeps a message whose item is not in the list rather than dropping it", () => {
  const map = problemsByItem([{ itemId: "ghost", message: "Two options share an id." }]);
  assert.deepEqual(map.get("ghost"), ["Two options share an id."]);
});

test("problemsByItem on a clean worksheet is an empty map", () => {
  assert.equal(problemsByItem([]).size, 0);
});
