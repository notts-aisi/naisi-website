/**
 * THE STANDING RED TEAM: every route and every authed page, requested as
 * every persona, against a real build.
 *
 * WHY. The audit of 8 September 2026 found thirteen routes whose gate
 * answered the wrong persona: a demoted reviewer kept a round, an ex-author
 * kept a delete, a `pending` account could tell a live round from a missing
 * one. Each was found by a person reading one handler, and the class is
 * "the gate's answer to persona X is not what the model says". A source
 * guard can read the order of calls (`tests/gate-before-data.test.mjs`) but
 * not the answer; only a request can. So this battery asks the question the
 * audit asked, for every handler and every page, every run, and
 * `tests/persona-route-gates.registry.mjs` is the answer key a person wrote.
 *
 * HOW. `scripts/e2e/run.mjs` starts a second copy of the build on
 * `E2E_PERSONA_ORIGIN`, pointed at a Firestore emulator, and
 * `scripts/e2e/lib/personas.mjs` seeds one account per persona THERE, so the
 * elevated roles never exist on the dev project (the harness's second
 * safety property stays literally true) and every route may be driven as
 * every persona, mutating ones included: what they mutate is the emulator.
 * Each route is requested with ids that address nothing and an empty JSON
 * body, so what comes back is the gate's answer or the first validation's,
 * and each page with `redirect: manual`, so a redirect is read rather than
 * followed. Every request carries its own forwarded address, because the
 * in-memory throttles would otherwise turn the later personas into 429s.
 *
 * RECORDING. With `E2E_PERSONA_RECORD=<path>` the battery writes what it
 * observed as JSON and asserts nothing but that every request answered. That
 * is how the registry was first written, and how a wholesale change is
 * re-keyed: record, read the diff as a list of decisions, edit the registry.
 *
 * SKIPPING. Without the two variables the runner sets, the battery skips and
 * says so, unless `E2E_PERSONA_BATTERY=required`, which CI sets so a missing
 * emulator is a failed job rather than a quiet one. It never runs against a
 * deployed backend: there is no emulator behind one.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { REPO_ROOT, loadEnv, runId } from "../lib/env.mjs";
import { PERSONA_NAMES, personaOrigin, withPersona } from "../lib/personas.mjs";
import { stripSource } from "../../../tests/lib/stripSource.mjs";
import { exportedHandlers, walkRoutes } from "../../../tests/lib/routeScan.mjs";
import { PAGES, ROUTES, REDIRECTS, expectedFor } from "../../../tests/persona-route-gates.registry.mjs";
import { readdirSync } from "node:fs";

const APP_DIR = join(REPO_ROOT, "src", "app");
const RECORD = process.env.E2E_PERSONA_RECORD ?? "";
const REQUIRED = process.env.E2E_PERSONA_BATTERY === "required";
const ARMED = Boolean(process.env.E2E_PERSONA_ORIGIN && process.env.FIRESTORE_EMULATOR_HOST);
const POOL = 6;

/**
 * Every request makes the server verify the persona's session cookie against
 * Firebase Auth with revocation checking, which is one Identity Toolkit call
 * per request, and a run is four thousand of them in a few minutes. On
 * 9 September 2026 the last fifteen answers of a run came back as "no
 * session" for personas whose cookies were fine a moment earlier. So a
 * refusal that reads as "no session" (a 401, or a redirect to sign in) for a
 * persona that HAS a cookie is asked once more after a pause, and only the
 * second answer counts. A genuine 401 for that persona answers 401 twice; a
 * throttled lookup answers correctly the second time. Every retry is counted
 * and printed, so a run that leaned on them says so.
 */
const RETRY_PAUSE_MS = 2000;
let retried = 0;
let retriesThatChanged = 0;
const looksLikeNoSession = (result) =>
  result.status === 401 || (result.locations ?? []).includes("/login");
async function withOneRetry(persona, request) {
  const first = await request();
  if (!persona.cookie || !looksLikeNoSession(first)) return first;
  retried += 1;
  await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
  const second = await request();
  if (JSON.stringify(second) !== JSON.stringify(first)) retriesThatChanged += 1;
  return second;
}

let forwarded = 0;

/**
 * A request to the persona server as `persona`: the thing under test, so a
 * bare `fetch` on purpose (tests/e2e-harness-fetch-guard.test.mjs keeps the
 * setup fetches under lib/ wrapped and the batteries' own unwrapped). Every
 * request carries its own forwarded address, because the server's in-memory
 * throttles key on the client address and four thousand requests from one
 * loopback peer would turn the later personas' answers into 429s that say
 * nothing about the gate. The address sits behind a trailing loopback hop,
 * which is the shape `clientIp()` trusts.
 */
async function personaFetch(persona, path, init = {}) {
  const origin = personaOrigin();
  forwarded += 1;
  const a = 10 + Math.floor(forwarded / 65536);
  const b = Math.floor(forwarded / 256) % 256;
  const c = forwarded % 256;
  const headers = new Headers(init.headers ?? {});
  headers.set("x-forwarded-for", `${a}.${b}.${c}.7, 127.0.0.1`);
  if (persona.cookie) headers.set("cookie", persona.cookie);
  return fetch(`${origin}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" });
}

/** A route requested after everything else, because a 200 revokes the persona's session. */
const LAST = new Set(["/api/auth/session#DELETE"]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Route keys as the coverage map keys them, with their exported methods. */
function routeSurfaces() {
  const out = [];
  for (const file of walkRoutes(join(APP_DIR, "api"))) {
    const key = `/${relative(APP_DIR, dirname(file)).split("\\").join("/")}`;
    const methods = exportedHandlers(stripSource(readFileSync(file, "utf8"))).map((h) => h.method);
    out.push({ key, methods });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Page keys under (app), the way the coverage map keys them. */
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
  return out.sort();
}

/** A request path from a key: route groups dropped, dynamic segments filled with ids that address nothing. */
export function pathFor(key) {
  return key
    .split("/")
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => seg.replace(/^\[\.{0,3}(\w+)\]$/, (_, name) => `e2e-missing-${name}`))
    .join("/") || "/";
}

async function requestRoute(persona, key, method, entry) {
  const drive = entry?.drive ?? {};
  const path = pathFor(key) + (drive.query ?? "");
  const init = { method, headers: {} };
  if (MUTATING.has(method)) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(drive.body ?? {});
  }
  const res = await personaFetch(persona, path, init);
  const text = await res.text();
  let keys = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) keys = Object.keys(body).sort();
    } catch {
      keys = null; // not JSON: a file, a page, an empty body
    }
  }
  const location = res.headers.get("location");
  return {
    status: res.status,
    keys,
    location: location ? new URL(location, "http://placeholder.invalid").pathname : null,
    excerpt: res.status >= 500 ? text.slice(0, 200) : undefined,
  };
}

/**
 * A page's answer: its status and EVERY redirect target it carries.
 *
 * A redirect from the authed layout arrives as a 307, because nothing has
 * been sent yet. A redirect from a NESTED layout or the page itself arrives
 * inside a 200: by then Next has flushed the shell, and the redirect travels
 * in the streamed React Server Components payload as an error digest
 * (`NEXT_REDIRECT;replace;/dashboard;307;`) that the client router carries
 * out, or, for a document without a router, as a `<meta http-equiv="refresh">`.
 * A battery that read only the status called every admin page open to every
 * member, which is how these shapes came to be read here.
 *
 * ALL of them are collected, because a gating layout and the page beneath it
 * render concurrently: when both redirect (the events layout sends a member
 * to the dashboard while the attendees page sends a non-SU visitor to the
 * event), both digests are in the stream and their order is whichever
 * finished first. The registry therefore says which targets are acceptable,
 * and every target observed has to be one of them.
 *
 * A path is normalised back to its key shape (`/events/manage/[id]`) so a
 * redirect to the requested id can be named.
 */
const RSC_REDIRECT = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);(\d{3});/g;
const META_REDIRECT = /<meta[^>]*http-equiv="refresh"[^>]*content="\d+;\s*url=([^"]+)"/gi;

function normalisePath(location) {
  return new URL(location.replace(/&amp;/g, "&"), "http://placeholder.invalid").pathname.replace(
    /\/e2e-missing-(\w+)/g,
    "/[$1]",
  );
}

async function requestPage(persona, key) {
  const res = await personaFetch(persona, pathFor(key), { method: "GET" });
  const text = await res.text();
  const locations = new Set();
  const header = res.headers.get("location");
  if (header) locations.add(normalisePath(header));
  if (res.status === 200) {
    for (const match of text.matchAll(RSC_REDIRECT)) locations.add(normalisePath(match[1]));
    for (const match of text.matchAll(META_REDIRECT)) locations.add(normalisePath(match[1]));
  }
  return { status: res.status, locations: [...locations].sort() };
}

/** Run `tasks` (thunks) with at most POOL in flight, in order of submission. */
async function drain(tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(POOL, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** The names of every redirect target observed, or the status when there was none. */
function pageOutcome(observed) {
  if (observed.locations.length === 0) return observed.status;
  return observed.locations.map(
    (path) => Object.keys(REDIRECTS).find((n) => REDIRECTS[n] === path) ?? `redirect:${path}`,
  );
}

/** Does an observed outcome satisfy an expectation (a status, a name, or a list of names)? */
function pageMatches(want, got) {
  if (typeof want === "number") return got === want;
  const allowed = Array.isArray(want) ? want : [want];
  return Array.isArray(got) && got.length > 0 && got.every((name) => allowed.includes(name));
}

describe("persona route gates on a real build", { skip: !ARMED && !REQUIRED ? "E2E_PERSONA_ORIGIN and FIRESTORE_EMULATOR_HOST are not set; scripts/e2e/run.mjs sets them when the emulator and the persona server come up. Set E2E_PERSONA_BATTERY=required to fail instead." : false }, () => {
  const personas = new Map();
  const observed = { routes: {}, pages: {} };
  const routes = routeSurfaces();
  const pages = pageSurfaces();

  before(async () => {
    loadEnv();
    assert.ok(ARMED, "E2E_PERSONA_BATTERY=required but the emulator and persona server are not up.");
    const id = runId();
    for (const name of PERSONA_NAMES) personas.set(name, await withPersona(id, name));
  });

  after(async () => {
    for (const persona of personas.values()) await persona.dispose().catch(() => {});
  });

  it("every route answers every persona", async () => {
    const cells = [];
    const last = [];
    for (const { key, methods } of routes) {
      for (const method of methods) {
        const entry = ROUTES[key]?.[method];
        for (const name of PERSONA_NAMES) {
          const cell = { key, method, name, entry };
          (LAST.has(`${key}#${method}`) ? last : cells).push(cell);
        }
      }
    }
    const run = (cell) => async () => {
      const persona = personas.get(cell.name);
      const result = await withOneRetry(persona, () => requestRoute(persona, cell.key, cell.method, cell.entry));
      observed.routes[cell.key] ??= {};
      observed.routes[cell.key][cell.method] ??= {};
      observed.routes[cell.key][cell.method][cell.name] = result;
    };
    await drain(cells.map(run));
    for (const cell of last) {
      await run(cell)();
      await personas.get(cell.name).refresh?.().catch(() => {});
    }
    assert.ok(Object.keys(observed.routes).length === routes.length, "some route was never requested");
  });

  it("every authed page answers every persona", async () => {
    const cells = [];
    for (const key of pages) for (const name of PERSONA_NAMES) cells.push({ key, name });
    await drain(
      cells.map((cell) => async () => {
        const persona = personas.get(cell.name);
        const result = await withOneRetry(persona, () => requestPage(persona, cell.key));
        observed.pages[cell.key] ??= {};
        observed.pages[cell.key][cell.name] = result;
      }),
    );
    assert.ok(Object.keys(observed.pages).length === pages.length, "some page was never requested");
  });

  it(RECORD ? "records what it observed" : "what it observed is what the registry says", () => {
    console.log(
      `[personas] ${retried} answer(s) that read as "no session" were asked again; ${retriesThatChanged} changed on the second ask.`,
    );
    if (RECORD) {
      mkdirSync(dirname(RECORD), { recursive: true });
      writeFileSync(RECORD, JSON.stringify(observed, null, 2));
      console.log(`[personas] recorded ${routes.length} routes and ${pages.length} pages to ${RECORD}`);
      return;
    }
    const failures = [];
    for (const { key, methods } of routes) {
      for (const method of methods) {
        const entry = ROUTES[key]?.[method];
        if (!entry) {
          failures.push(`${key}#${method}: no registry entry`);
          continue;
        }
        for (const name of PERSONA_NAMES) {
          const want = expectedFor(entry.expect, name);
          const got = observed.routes[key][method][name];
          if (got.status !== want) {
            failures.push(
              `${key}#${method} as ${name}: expected ${want}, got ${got.status}` +
                (got.excerpt ? ` (${got.excerpt.replace(/\s+/g, " ").slice(0, 120)})` : ""),
            );
          } else if (got.status < 300 && got.keys && entry.fields) {
            const extra = got.keys.filter((k) => !entry.fields.includes(k));
            if (extra.length > 0) failures.push(`${key}#${method} as ${name}: unlisted response fields ${extra.join(", ")}`);
          } else if (got.status < 300 && got.keys && !entry.fields) {
            failures.push(`${key}#${method} as ${name}: a 2xx JSON body (${got.keys.join(", ")}) and no fields list in the registry`);
          }
        }
      }
    }
    for (const key of pages) {
      const entry = PAGES[key];
      if (!entry) {
        failures.push(`${key}: no registry entry`);
        continue;
      }
      for (const name of PERSONA_NAMES) {
        const want = expectedFor(entry.expect, name);
        const got = pageOutcome(observed.pages[key][name]);
        if (!pageMatches(want, got)) {
          failures.push(`${key} as ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    const shown = failures.slice(0, 150);
    assert.deepEqual(
      shown,
      [],
      `\n${shown.join("\n")}${failures.length > shown.length ? `\n... and ${failures.length - shown.length} more` : ""}\n`,
    );
  });
});
