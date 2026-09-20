/**
 * The numbering and validation behind `/sources`
 * (`src/lib/firestore/sourceSheets.ts`).
 *
 * Run with `npm test`.
 *
 * ## Why this file is worth more than the rest of the feature's tests
 *
 * Every other mistake in a source sheet is fixable with a deploy. A SOURCE
 * NUMBER is not: it is set in superscript on a poster that has been printed,
 * pinned up and handed out. If the site ever renumbers, the paper in
 * somebody's hand points at the wrong citation and nothing in the system can
 * detect that it has happened.
 *
 * So the number is stored per row and minted from a counter that only ever
 * grows, and the three properties below are the ones that keep it true:
 *
 *  1. **Delete-then-add never reuses a number.** The two obvious ways of
 *     working out the next number, `items.length + 1` and `max(n) + 1`, are
 *     both correct until a row is deleted and then both hand the deleted
 *     number to a different source. The counter is what makes the gap
 *     permanent.
 *  2. **A duplicate is refused.** Two rows sharing a number means one
 *     superscript on the poster points at two different things.
 *  3. **A gap survives a round trip.** A stored list of 1, 3 and 7 has to come
 *     back as 1, 3 and 7, with the counter still above all of them, or a
 *     reload quietly repairs the numbering into something the poster
 *     disagrees with.
 *
 * Reordering is tested alongside them because it is the operation most likely
 * to be mistaken for renumbering: it changes the order rows are READ in and
 * must leave every `n` exactly where it was.
 *
 * ## Why the loader
 *
 * The module under test is TypeScript and this repo's Node does not strip
 * types, so the graph is transpiled in memory by the shared loader in
 * `tests/lib/tsLoader.mjs`. It is registered in that suite's `USERS` map with
 * the reason, which is how a loader user stays visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./lib/tsLoader.mjs";

const { loadTs } = createLoader();
const loadModule = () => loadTs("lib/firestore/sourceSheets.ts");

/** A row as the editor holds one, with the fields a test does not care about. */
function row(n, over = {}) {
  return { id: `id-${n}`, n, name: `Source ${n}`, url: "https://example.ac.uk/a", ...over };
}

test("a minted number is never reused after the row is deleted", async () => {
  const { appendSourceItem, removeSourceItem } = await loadModule();

  // Three rows, minted one at a time exactly as the editor mints them.
  let state = { items: [], nextNumber: 1 };
  for (let i = 0; i < 3; i += 1) state = appendSourceItem(state.items, state.nextNumber);
  assert.deepEqual(
    state.items.map((item) => item.n),
    [1, 2, 3],
  );

  // Delete the middle one. `2` is printed on the poster beside whatever that
  // row said, so it must never be handed to anything else.
  const afterDelete = removeSourceItem(state.items, state.items[1].id);
  assert.deepEqual(
    afterDelete.map((item) => item.n),
    [1, 3],
  );

  const afterAdd = appendSourceItem(afterDelete, state.nextNumber);
  assert.deepEqual(
    afterAdd.items.map((item) => item.n),
    [1, 3, 4],
    "the new row took 4. `items.length + 1` would have given it 3 and `max(n) + 1` would "
      + "have given it 4 here but 2 after deleting the last row instead of the middle one.",
  );
});

test("deleting the LAST row still does not free its number", async () => {
  // The case `max(n) + 1` gets wrong, which the test above cannot see.
  const { appendSourceItem, removeSourceItem } = await loadModule();

  let state = { items: [], nextNumber: 1 };
  for (let i = 0; i < 3; i += 1) state = appendSourceItem(state.items, state.nextNumber);

  const afterDelete = removeSourceItem(state.items, state.items[2].id);
  assert.deepEqual(afterDelete.map((item) => item.n), [1, 2]);

  const afterAdd = appendSourceItem(afterDelete, state.nextNumber);
  assert.deepEqual(
    afterAdd.items.map((item) => item.n),
    [1, 2, 4],
    "3 was printed and is gone for good; `max(n) + 1` would have reissued it.",
  );
});

test("the counter never moves backwards, whatever the list now holds", async () => {
  const { advanceNextNumber } = await loadModule();

  assert.equal(advanceNextNumber(10, []), 10, "an emptied list does not reset the counter");
  assert.equal(advanceNextNumber(10, [row(2)]), 10);
  // A number typed by hand above the counter pulls the counter past it, so the
  // next minted row cannot collide with one an admin set deliberately.
  assert.equal(advanceNextNumber(3, [row(40)]), 41);
  // A counter stored below the numbers in use is repaired upwards on read.
  assert.equal(advanceNextNumber(1, [row(1), row(2), row(3)]), 4);
  // Nonsense in, a usable counter out, never zero or negative.
  assert.equal(advanceNextNumber(0, []), 1);
  assert.equal(advanceNextNumber(Number.NaN, [row(5)]), 6);
});

test("a duplicate number is refused, and the row it names is the second one", async () => {
  const { validateSourceItems } = await loadModule();

  const items = [row(1), { ...row(2), id: "id-dup", n: 1 }];
  const errors = validateSourceItems(items);
  const duplicate = errors.filter((e) => e.field === "n");

  assert.equal(duplicate.length, 1, "exactly one row is at fault, not both");
  assert.equal(duplicate[0].id, "id-dup");
  assert.match(duplicate[0].message, /already used/);
});

test("a number outside the printable range is refused", async () => {
  const { validateSourceItems, SOURCE_SHEET_LIMITS } = await loadModule();

  for (const bad of [0, -1, 1.5, Number.NaN, SOURCE_SHEET_LIMITS.maxNumber + 1]) {
    const errors = validateSourceItems([{ ...row(1), n: bad }]);
    assert.ok(
      errors.some((e) => e.field === "n"),
      `${bad} should be refused as a source number`,
    );
  }
});

test("a gap survives a round trip through normalizeSourceSheet", async () => {
  const { normalizeSourceSheet } = await loadModule();

  const sheet = normalizeSourceSheet("freshers-2026", {
    title: "Freshers poster",
    items: [row(1), row(3), row(7)],
    nextNumber: 8,
    updatedAt: new Date("2026-09-01T10:00:00Z"),
  });

  assert.deepEqual(
    sheet.items.map((item) => item.n),
    [1, 3, 7],
    "reading the document back must not renumber it",
  );
  assert.equal(sheet.nextNumber, 8);
});

test("normalize refuses to guess at a row whose number is unusable", async () => {
  // Dropped rather than repaired: a repaired number is a wrong number that
  // looks right, and the only honest repair is an admin reading the poster.
  const { normalizeSourceSheet } = await loadModule();

  const sheet = normalizeSourceSheet("s", {
    items: [row(1), { ...row(2), n: "two" }, { ...row(3), id: "" }, row(4)],
    nextNumber: 5,
  });

  assert.deepEqual(sheet.items.map((item) => item.n), [1, 4]);
});

test("reordering changes the order and leaves every number untouched", async () => {
  const { moveSourceItem } = await loadModule();

  const items = [row(1), row(2), row(3)];
  const moved = moveSourceItem(items, 0, 1);

  assert.deepEqual(moved.map((item) => item.n), [2, 1, 3]);
  assert.deepEqual(
    items.map((item) => item.n),
    [1, 2, 3],
    "the input array must not be mutated: React compares by identity",
  );
  // Out of range returns the SAME reference, so the up arrow on the first row
  // cannot mark an unchanged form as dirty.
  assert.equal(moveSourceItem(items, 0, -1), items);
  assert.equal(moveSourceItem(items, 2, 1), items);
});

test("an empty note is dropped rather than stored as an empty string", async () => {
  const { normalizeSourceSheet } = await loadModule();

  const sheet = normalizeSourceSheet("s", {
    items: [
      { ...row(1), comment: "   " },
      { ...row(2), comment: "  Figure 3.  " },
    ],
    nextNumber: 3,
  });

  assert.ok(
    !("comment" in sheet.items[0]),
    "an empty note must be absent, so the public page renders no element for it",
  );
  assert.equal(sheet.items[1].comment, "Figure 3.");
});

test("a link is validated at write time, with credentials and non-http refused", async () => {
  const { validateSourceItems } = await loadModule();

  const bad = [
    "",
    "example.ac.uk/report",
    "javascript:alert(1)",
    "mailto:someone@example.ac.uk",
    "/sources/local",
    "https://naisi.uk@evil.example",
  ];
  for (const url of bad) {
    const errors = validateSourceItems([{ ...row(1), url }]);
    assert.ok(
      errors.some((e) => e.field === "url"),
      `${JSON.stringify(url)} should be refused as a source link`,
    );
  }

  for (const url of ["https://example.ac.uk/report", "http://example.ac.uk/report"]) {
    const errors = validateSourceItems([{ ...row(1), url }]);
    assert.deepEqual(errors, [], `${url} should pass`);
  }
});

test("the same check is applied again at render, and a bad row degrades to text", async () => {
  // The public page asks this rather than trusting the stored string: a row
  // written before the validator existed, or typed into the Firestore console,
  // must not put an unchecked scheme behind an anchor on a public page.
  const { renderableSourceUrl, sourceHostname } = await loadModule();

  assert.equal(renderableSourceUrl("javascript:alert(1)"), null);
  assert.equal(renderableSourceUrl("https://naisi.uk@evil.example"), null);
  assert.equal(renderableSourceUrl("  "), null);
  assert.equal(
    renderableSourceUrl("https://www.example.ac.uk/report"),
    "https://www.example.ac.uk/report",
  );

  assert.equal(sourceHostname("https://www.example.ac.uk/report"), "example.ac.uk");
  assert.equal(sourceHostname("javascript:alert(1)"), "");
});

test("the slug grammar is what can be printed under a code", async () => {
  const { validateSourceSlug, suggestSourceSlug } = await loadModule();

  assert.equal(validateSourceSlug("freshers-fair-2026"), null);
  for (const bad of ["", "Freshers Fair", "freshers_fair", "-freshers", "freshers-", "a/b"]) {
    assert.ok(validateSourceSlug(bad), `${JSON.stringify(bad)} should be refused as a slug`);
  }

  assert.equal(suggestSourceSlug("Freshers fair poster, September 2026"), "freshers-fair-poster-september-2026");
  assert.equal(validateSourceSlug(suggestSourceSlug("What's the risk?")), null);
});
