/**
 * A page a printed QR code lands on never answers with `notFound()`.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * WHY. For a route that matches and THEN calls `notFound()` (a dynamic page
 * whose document has gone), Next answers 404 with an EMPTY body and draws the
 * not-found screen in the browser once its scripts have arrived. Measured on a
 * production build in September 2026: the body was one hidden div, and the
 * message existed only inside the script payload. An address that matches no
 * route at all is different, and is server-rendered properly, which is why
 * this went unnoticed: the not-found pages all LOOK fine on a laptop.
 *
 * A printed code is scanned on a phone, at a stall, on whatever signal the
 * hall has. Its landing page is kept out of the `(public)` group for exactly
 * that reason (that group's main element is invisible until hydration). A
 * blank screen until the JavaScript lands is the same failure by another door,
 * and it happens precisely when something has already gone wrong: the event on
 * the poster was deleted, or the material's sources were unpublished.
 *
 * So a landing page renders its "this is not here" state itself, as ordinary
 * server-rendered HTML, the way /sources always has. This file holds that for
 * every landing page, and checks that every printed destination IS one of
 * them, so a code pointed at a new kind of page brings the question with it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const codeOf = (path) =>
  readFileSync(join(REPO_ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/**
 * Every page a printed code is designed to land on, with the address shape
 * that reaches it and what it shows when its document is not there.
 */
const LANDING_PAGES = [
  {
    file: "src/app/links/page.tsx",
    matches: /^\/links$/,
    whenMissing: "has no document of its own to be missing: it serves the built-in rows whatever is stored",
  },
  {
    file: "src/app/events/[id]/calendar/page.tsx",
    matches: /^\/events\/[^/]+\/calendar$/,
    whenMissing: "renders EventNotListed: what happened, and links to upcoming events and /links",
  },
  {
    file: "src/app/(public)/sources/[slug]/page.tsx",
    matches: /^\/sources\/[^/]+$/,
    whenMissing: "renders a calm 'not published yet' page, because the reader is holding the poster",
  },
];

const { loadTs } = createLoader();
const { PRINTED_LINKS } = await loadTs("lib/campaign/printedLinks.ts");

describe("every landing page answers a missing document itself", () => {
  for (const page of LANDING_PAGES) {
    test(`${page.file} never calls notFound()`, () => {
      assert.ok(existsSync(join(REPO_ROOT, page.file)), `${page.file} has moved: update LANDING_PAGES`);
      const code = codeOf(page.file);
      assert.doesNotMatch(
        code,
        /\bnotFound\s*\(/,
        `${page.file} calls notFound(). For a route that matches, Next answers that with an EMPTY ` +
          "body and draws the message only once its scripts arrive, which is a blank screen on " +
          `fair-day signal. Render the state from the page instead: it ${page.whenMissing}.`,
      );
      assert.doesNotMatch(code, /from "next\/navigation"[^;]*\bnotFound\b|\bnotFound\b[^;]*from "next\/navigation"/);
      assert.ok(page.whenMissing.length >= 30, "say what the page shows instead");
    });
  }

  test("and none of them has a not-found.tsx beside it to fall back on by accident", () => {
    for (const page of LANDING_PAGES) {
      const beside = join(REPO_ROOT, dirname(page.file), "not-found.tsx");
      assert.equal(existsSync(beside), false, `${beside} would only ever render in the browser`);
    }
  });
});

describe("every printed destination is a landing page", () => {
  for (const { slug, destination } of PRINTED_LINKS) {
    test(`/q/${slug} goes to a page on this list, or to another site`, () => {
      if (/^https:\/\//.test(destination)) return; // another site's 404 is not ours to render
      const path = destination.split(/[?#]/)[0];
      const page = LANDING_PAGES.find((candidate) => candidate.matches.test(path));
      assert.ok(
        page,
        `/q/${slug} lands on ${path}, which is not in LANDING_PAGES. Add the page that serves it, ` +
          "and make sure it renders its own missing state and never calls notFound().",
      );
    });
  }
});

describe("what the calendar page says when its event is gone", () => {
  const code = codeOf("src/app/events/[id]/calendar/EventNotListed.tsx");

  test("it is a Server Component: no script is needed to read it", () => {
    assert.doesNotMatch(readFileSync(join(REPO_ROOT, "src/app/events/[id]/calendar/EventNotListed.tsx"), "utf8").slice(0, 200), /["']use client["']/);
    assert.doesNotMatch(code, /\buse(State|Effect|Router|SearchParams|Pathname)\b/);
  });

  test("it offers the two places that help, and says nothing is wrong with the phone", () => {
    assert.match(code, /href="\/events"/);
    assert.match(code, /href="\/links"/);
    assert.match(code, /Nothing is\s+wrong with your phone/);
  });

  test("the page returns it, and keeps the missing event out of search results", () => {
    const page = codeOf("src/app/events/[id]/calendar/page.tsx");
    assert.match(page, /if \(!event\) return <EventNotListed \/>;/);
    assert.match(page, /if \(!event\) return \{ title: "Event not found", robots: \{ index: false/);
  });
});
