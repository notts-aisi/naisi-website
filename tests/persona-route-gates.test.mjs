/**
 * THE STANDING RED TEAM'S ANSWER KEY AGREES WITH THE TREE, offline.
 *
 * `tests/persona-route-gates.registry.mjs` says what every route and every
 * authed page answers each persona, and
 * `scripts/e2e/tests/persona-route-gates.test.mjs` drives every cell against
 * a real build with an emulator behind it. That battery needs a build, Java
 * and firebase-tools; this file needs nothing, runs under `npm test`, and is
 * what makes a NEW route fail on arrival: it walks `src/app/api` for every
 * exported handler and `src/app/(app)` for every page, and requires an entry
 * for each one, and a route or page for each entry.
 *
 * It also reads every entry for the things a person can get wrong writing
 * three thousand cells by hand: a persona name that is not one, a status
 * that is not a status, a page outcome that names no redirect, a `fields`
 * list with no 2xx to apply to, a 2xx for a persona on a route with no
 * `fields` list, an `anonymous` 2xx on a route with no `public` reason, and
 * a `why` that is a placeholder.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";
import { exportedHandlers, walkRoutes } from "./lib/routeScan.mjs";
import {
  PAGES,
  PERSONA_NAMES,
  REDIRECTS,
  ROUTES,
  expectedFor,
} from "./persona-route-gates.registry.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(REPO_ROOT, "src", "app");

function routeSurfaces() {
  const out = new Map();
  for (const file of walkRoutes(join(APP_DIR, "api"))) {
    const key = `/${relative(APP_DIR, dirname(file)).split("\\").join("/")}`;
    out.set(key, exportedHandlers(stripSource(readFileSync(file, "utf8"))).map((h) => h.method));
  }
  return out;
}

function pageSurfaces() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") out.push(`/${relative(APP_DIR, dir).split("\\").join("/")}`);
    }
  };
  walk(join(APP_DIR, "(app)"));
  return out;
}

const routes = routeSurfaces();
const pages = pageSurfaces();
const STATUS = (v) => Number.isInteger(v) && v >= 200 && v < 600;

describe("the registry and the tree agree in both directions", () => {
  test("the walk found the tree", () => {
    assert.ok(routes.size > 150, `only ${routes.size} routes found`);
    assert.ok(pages.length > 50, `only ${pages.length} authed pages found`);
    assert.equal(PERSONA_NAMES.length, 15);
  });

  test("every route handler has an entry, and every route entry has a handler", () => {
    const missing = [];
    for (const [key, methods] of routes) {
      for (const method of methods) {
        if (!ROUTES[key]?.[method]) missing.push(`${key}#${method}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      "A handler with no entry in tests/persona-route-gates.registry.mjs. Decide what every " +
        "persona should get and write it down with the reason; the battery will hold it to that.",
    );
    const stale = [];
    for (const [key, byMethod] of Object.entries(ROUTES)) {
      for (const method of Object.keys(byMethod)) {
        if (!routes.get(key)?.includes(method)) stale.push(`${key}#${method}`);
      }
    }
    assert.deepEqual(stale, [], "These registry entries name no handler in the tree. Delete them.");
  });

  test("every authed page has an entry, and every page entry has a page", () => {
    const missing = pages.filter((key) => !PAGES[key]);
    assert.deepEqual(missing, [], "A page under src/app/(app) with no entry in the registry.");
    const stale = Object.keys(PAGES).filter((key) => !pages.includes(key));
    assert.deepEqual(stale, [], "These page entries name no page in the tree. Delete them.");
  });

  test("every route entry is well formed", () => {
    const problems = [];
    for (const [key, byMethod] of Object.entries(ROUTES)) {
      for (const [method, entry] of Object.entries(byMethod)) {
        const label = `${key}#${method}`;
        if (typeof entry.why !== "string" || entry.why.length < 30) problems.push(`${label}: why is missing or too short`);
        if (!entry.expect || typeof entry.expect !== "object") {
          problems.push(`${label}: no expect map`);
          continue;
        }
        for (const [persona, status] of Object.entries(entry.expect)) {
          if (persona !== "*" && !PERSONA_NAMES.includes(persona)) problems.push(`${label}: unknown persona ${persona}`);
          if (!STATUS(status)) problems.push(`${label}: ${persona} expects ${JSON.stringify(status)}, not a status`);
        }
        const outcomes = PERSONA_NAMES.map((p) => [p, expectedFor(entry.expect, p)]);
        const unresolved = outcomes.filter(([, s]) => s === undefined).map(([p]) => p);
        if (unresolved.length > 0) problems.push(`${label}: no expectation for ${unresolved.join(", ")} and no "*"`);
        const anonymous = expectedFor(entry.expect, "anonymous");
        if (anonymous >= 200 && anonymous < 300 && !entry.public) {
          problems.push(`${label}: anonymous gets ${anonymous}; say why in \`public\``);
        }
        const twoxx = outcomes.some(([, s]) => s >= 200 && s < 300);
        if (entry.fields && !twoxx) problems.push(`${label}: a fields list but no persona gets a 2xx`);
        if (entry.fields && (!Array.isArray(entry.fields) || entry.fields.some((f) => typeof f !== "string"))) {
          problems.push(`${label}: fields must be a list of strings`);
        }
        if (entry.drive && (typeof entry.drive.why !== "string" || entry.drive.why.length < 20)) {
          problems.push(`${label}: a drive override needs a reason`);
        }
      }
    }
    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  });

  test("every page entry is well formed", () => {
    const problems = [];
    for (const [key, entry] of Object.entries(PAGES)) {
      if (typeof entry.why !== "string" || entry.why.length < 30) problems.push(`${key}: why is missing or too short`);
      if (!entry.expect || typeof entry.expect !== "object") {
        problems.push(`${key}: no expect map`);
        continue;
      }
      for (const [persona, outcome] of Object.entries(entry.expect)) {
        if (persona !== "*" && !PERSONA_NAMES.includes(persona)) problems.push(`${key}: unknown persona ${persona}`);
        const isName = (v) => typeof v === "string" && v in REDIRECTS;
        const ok =
          STATUS(outcome) ||
          isName(outcome) ||
          (Array.isArray(outcome) && outcome.length > 1 && outcome.every(isName));
        if (!ok) {
          problems.push(
            `${key}: ${persona} expects ${JSON.stringify(outcome)}, neither a status, a REDIRECTS name, nor a list of two or more names`,
          );
        }
      }
      const unresolved = PERSONA_NAMES.filter((p) => expectedFor(entry.expect, p) === undefined);
      if (unresolved.length > 0) problems.push(`${key}: no expectation for ${unresolved.join(", ")} and no "*"`);
      const anonymous = expectedFor(entry.expect, "anonymous");
      if (anonymous !== "login" && anonymous !== 404) {
        problems.push(`${key}: anonymous gets ${JSON.stringify(anonymous)}; an authed page sends a stranger to sign in`);
      }
    }
    assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  });
});
