import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The applicant funnel's mobile contract, pinned in CSS.
 *
 * The 21 and 22 September fairs are phone traffic, so the funnel's stylesheets
 * carry rules a person cannot see by reading a diff on a laptop. This file
 * pins the four that would cost an application if they were quietly dropped,
 * and it does it by parsing the stylesheets rather than by matching strings,
 * so a rule that moves inside a file still counts and a rule that moves INTO a
 * media block no longer does.
 *
 * What each check actually checks, stated plainly because a heuristic nobody
 * can describe is a heuristic nobody can act on when it fails:
 *
 *   1. THE ADAPT TAIL. Every funnel module ends with the house mobile block
 *      (docs/mobile-conventions.md): a `@media (max-width: 48rem)` block, with
 *      an optional `@media (max-width: 36rem)` block after it for small
 *      phones. Nothing else may be the file's last media block.
 *
 *   2. NO CUSTOM PROPERTY IN A MEDIA CONDITION. `@media (max-width:
 *      var(--bp-md))` silently matches nothing: custom properties resolve at
 *      computed-value time, after media matching. It fails with no error, so
 *      the only thing that catches it is a test.
 *
 *   3. NO WIDE FIXED WIDTH OUTSIDE A MEDIA BLOCK. A `width`, `min-width` or
 *      `flex-basis` (including the basis inside a `flex` shorthand) declared
 *      wider than 20rem in a module's unconditional rules is what pushes a
 *      320px screen into a horizontal document scroll, and so is the lower
 *      bound of a `minmax()` in `grid-template-columns` (a track cannot go
 *      under it, so an auto-fit grid of them sets the page's width). The grid
 *      case is forgiven when the file's own 48rem block redeclares
 *      `grid-template-columns`, which is the house way of collapsing to one
 *      column. `max-width` is deliberately NOT flagged: a cap cannot overflow
 *      anything.
 *
 *      What this does NOT see, stated so nobody reads more into a green run
 *      than is there: values in px, em or ch, anything inside `calc()`, a
 *      width applied from another module or from an inline style, and any
 *      declaration nested inside an at-rule other than the media blocks it
 *      already skips.
 *
 *   4. THE GRID SCROLLS ITSELF. The availability grid's day columns scroll
 *      inside their own container if they ever have to, never the document, so
 *      `.cells` declares `overflow-x: auto` and the head strip above them is a
 *      real handle: `touch-action: pan-x`, at the 44px floor, because the cells
 *      refuse pans so a drag paints. The board declares the 44px phone cell
 *      height and the cells read that height from the container rather than
 *      hard-coding one.
 *
 *   5. NO `overflow-wrap: break-word`. `break-word` wraps the rendered line
 *      but leaves the box's min-content width at the longest word, so a flex
 *      or grid item still grows to hold an admin-typed label in one piece and
 *      the document scrolls sideways. `anywhere` is the house choice because
 *      it is the one that lowers min-content
 *      (src/components/ui/MemberText.module.css).
 *
 *   6. THE TOUCH FLOOR. Every interactive control in the funnel declares
 *      `min-height: 2.75rem` (44px) in its unconditional rule, which is the
 *      enforced floor for a public surface (docs/touch-targets.md).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const ADMISSIONS_DIR = path.join(root, "src/features/admissions");

/** Every module the funnel mobile pass owns. */
function funnelModules() {
  const admissions = readdirSync(ADMISSIONS_DIR)
    .filter((name) => name.endsWith(".module.css"))
    .sort()
    .map((name) => path.join("src/features/admissions", name));
  return [
    ...admissions,
    "src/features/courses/GroupPicker.module.css",
    "src/features/courses/CourseCTA.module.css",
    "src/features/courses/DropOutCard.module.css",
    "src/app/(public)/courses/courses.module.css",
    "src/app/(public)/applications/applications.module.css",
    "src/app/(public)/apply/[roundId]/apply.module.css",
  ];
}

function read(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

/** Comments carry example CSS and prose; every check below reads code only. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Top-level blocks in source order: `{ prelude, body, isAtRule }`.
 * Nested blocks stay inside their parent's body, which is what makes "outside
 * a media block" answerable.
 */
function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let preludeStart = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({
          prelude: css.slice(preludeStart, start).trim(),
          body: css.slice(start + 1, i),
        });
        preludeStart = i + 1;
      }
    }
  }
  return blocks;
}

function mediaBlocks(css) {
  return topLevelBlocks(stripComments(css)).filter((block) =>
    block.prelude.startsWith("@media"),
  );
}

/** The declarations of every top-level rule that is not an at-rule. */
function unconditionalRules(css) {
  return topLevelBlocks(stripComments(css)).filter(
    (block) => !block.prelude.startsWith("@"),
  );
}

function declarations(body) {
  return body
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon === -1) return null;
      return {
        property: line.slice(0, colon).trim().toLowerCase(),
        value: line.slice(colon + 1).trim(),
      };
    })
    .filter(Boolean);
}

/** Does this selector list target `.name` as a selector of its own? */
function selects(prelude, className) {
  const pattern = new RegExp(`\\.${className}(?![\\w-])`);
  return prelude.split(",").some((part) => pattern.test(part));
}

test("every funnel module ends with the house mobile adapt block", () => {
  for (const rel of funnelModules()) {
    const queries = mediaBlocks(read(rel)).map((block) =>
      block.prelude.replace(/\s+/g, " ").trim(),
    );
    assert.ok(
      queries.some((q) => q.includes("max-width: 48rem")),
      `${rel} has no @media (max-width: 48rem) block`,
    );
    const last = queries.at(-1);
    assert.ok(
      last.includes("max-width: 48rem") || last.includes("max-width: 36rem"),
      `${rel} ends on "${last}" rather than on its mobile adapt block`,
    );
    if (last.includes("max-width: 36rem")) {
      const before = queries.at(-2) ?? "";
      assert.ok(
        before.includes("max-width: 48rem"),
        `${rel} puts a 36rem block somewhere other than after the 48rem block`,
      );
    }
  }
});

test("no funnel module puts a custom property in a media condition", () => {
  for (const rel of funnelModules()) {
    for (const block of mediaBlocks(read(rel))) {
      assert.ok(
        !block.prelude.includes("var("),
        `${rel} uses var() in "${block.prelude}", which silently matches nothing`,
      );
    }
  }
});

/** The body of the file's 48rem adapt block, or "" when it has none. */
function adaptBlockBody(css) {
  const block = mediaBlocks(css).find((b) =>
    b.prelude.replace(/\s+/g, " ").includes("max-width: 48rem"),
  );
  return block ? block.body : "";
}

test("no funnel module fixes a width over 20rem outside a media block", () => {
  const WIDTHS = new Set(["width", "min-width", "flex-basis"]);
  for (const rel of funnelModules()) {
    const css = read(rel);
    // A wide grid track is forgiven only when the file collapses the grid in
    // its own adapt block, which is what every funnel grid does today.
    const gridCollapsed = /grid-template-columns\s*:/.test(adaptBlockBody(css));
    for (const rule of unconditionalRules(css)) {
      for (const { property, value } of declarations(rule.body)) {
        const rems = [];
        if (WIDTHS.has(property)) {
          const match = /^([\d.]+)rem$/.exec(value);
          if (match) rems.push(Number(match[1]));
        }
        if (property === "flex") {
          // `flex: 0 0 3.5rem` carries a basis; `flex: 1 1 auto` does not.
          const match = /(?:^|\s)([\d.]+)rem(?:\s|$)/.exec(value);
          if (match) rems.push(Number(match[1]));
        }
        if (property === "grid-template-columns" && !gridCollapsed) {
          // `repeat(auto-fit, minmax(24rem, 1fr))` is a fixed width in a
          // grid's clothing: the track never goes under the lower bound.
          for (const match of value.matchAll(/minmax\(\s*([\d.]+)rem/g)) {
            rems.push(Number(match[1]));
          }
        }
        for (const rem of rems) {
          assert.ok(
            rem <= 20,
            `${rel} sets ${property}: ${value} on "${rule.prelude}" outside a media block`,
          );
        }
      }
    }
  }
});

test("no funnel module wraps with break-word instead of anywhere", () => {
  for (const rel of funnelModules()) {
    for (const block of topLevelBlocks(stripComments(read(rel)))) {
      // Media blocks nest their rules inside the body, so scanning the raw
      // declarations of every top-level block covers both levels at once.
      assert.ok(
        !/overflow-wrap\s*:\s*break-word/.test(block.body),
        `${rel} uses overflow-wrap: break-word, which does not lower min-content width`,
      );
    }
  }
});

test("the availability grid scrolls its day columns, not the document", () => {
  const css = read("src/features/admissions/AvailabilityGrid.module.css");
  const rules = unconditionalRules(css);

  const cells = rules.find((rule) => selects(rule.prelude, "cells"));
  assert.ok(cells, "AvailabilityGrid has no unconditional .cells rule");
  const cellsDecls = declarations(cells.body);
  assert.ok(
    cellsDecls.some((d) => d.property === "overflow-x" && d.value === "auto"),
    ".cells must declare overflow-x: auto so the columns scroll inside it",
  );

  const board = rules.find((rule) => selects(rule.prelude, "board"));
  assert.ok(board, "AvailabilityGrid has no unconditional .board rule");
  assert.ok(
    declarations(board.body).some(
      (d) => d.property === "--slot-height" && d.value === "2.75rem",
    ),
    ".board must set the phone cell height to the 2.75rem touch floor",
  );

  const cell = rules.find((rule) => rule.prelude.trim() === ".cell");
  assert.ok(cell, "AvailabilityGrid has no unconditional .cell rule");
  assert.ok(
    declarations(cell.body).some(
      (d) => d.property === "height" && d.value.includes("var(--slot-height"),
    ),
    ".cell must read its height from --slot-height, not hard-code one",
  );

  // The handle. `.cell` is touch-action: none so a drag paints, which leaves
  // the head strip as the only place a finger could pan the columns from.
  assert.ok(
    declarations(board.body).some(
      (d) => d.property === "--head-height" && d.value === "2.75rem",
    ),
    ".board must hold the head strip at the 2.75rem touch floor",
  );
  const columnHead = rules.find((rule) => selects(rule.prelude, "columnHead"));
  assert.ok(columnHead, "AvailabilityGrid has no unconditional .columnHead rule");
  const headDecls = declarations(columnHead.body);
  assert.ok(
    headDecls.some((d) => d.property === "touch-action" && d.value === "pan-x"),
    ".columnHead must declare touch-action: pan-x so the scroller has a handle",
  );
  assert.ok(
    headDecls.some(
      (d) => d.property === "height" && d.value.includes("var(--head-height"),
    ),
    ".columnHead must read its height from --head-height, not hard-code one",
  );
});

test("every interactive control in the funnel declares the 44px floor", () => {
  /** module -> the classes that are the funnel's tap targets. */
  const CONTROLS = {
    "src/features/admissions/ApplyFlow.module.css": ["withdrawLink", "hubLink"],
    "src/features/admissions/AvailabilityGrid.module.css": ["stripButton", "clear"],
    "src/features/admissions/ProgrammePreference.module.css": ["option"],
    "src/features/courses/GroupPicker.module.css": [
      "slot",
      "slotStatic",
      "button",
      "secondary",
    ],
    "src/features/courses/CourseCTA.module.css": ["button"],
    "src/features/courses/DropOutCard.module.css": [
      "reveal",
      "input",
      "danger",
      "cancel",
    ],
    "src/app/(public)/applications/applications.module.css": [
      "back",
      "button",
      "secondary",
    ],
    "src/app/(public)/apply/[roundId]/apply.module.css": ["button"],
  };

  for (const [rel, classes] of Object.entries(CONTROLS)) {
    const rules = unconditionalRules(read(rel));
    for (const className of classes) {
      const declared = rules
        .filter((rule) => selects(rule.prelude, className))
        .flatMap((rule) => declarations(rule.body))
        .some((d) => d.property === "min-height" && d.value === "2.75rem");
      assert.ok(
        declared,
        `${rel}: .${className} does not declare min-height: 2.75rem (docs/touch-targets.md)`,
      );
    }
  }
});
