/**
 * A ROUTE PROVES WHO IS CALLING BEFORE IT READS OR WRITES ANYTHING.
 *
 * WHY. The order of the first two things a handler does decides what an
 * unauthenticated probe learns. `POST /api/verify-email/send` once validated
 * the address before it looked for a session (#209), so a signed-out request
 * was told whether its input was well formed by a route that should have
 * said nothing but 401; the uni-email gate battery exists because of it. The
 * audit of 8 September 2026 found the same shape in the other direction on
 * three routes: a document read, and 404 or 400 answered from it, before the
 * caller's right to know it existed was checked, so a `pending` account could
 * tell a live admission round from a missing one, and a plain member could
 * tell a course group with a run from one without. Each of those is a small
 * oracle; the class is "data before gate", and no test walked the tree for it.
 *
 * WHAT IT CHECKS, per exported handler under `src/app/api`:
 *
 *  1. THE ORDER. The handler's calls are read in order. The first one that is
 *     a recognised gate (`GATES`, or a method in `METHOD_GATES`) has to come
 *     before the first one that touches Firestore (`.collection`, `.doc`,
 *     `.collectionGroup`, `.runTransaction`, `.batch`, `.getAll`,
 *     `.bulkWriter`). A helper defined in the same file is read the same way
 *     at the point it is called, so a gate wrapped in `requireEnroller()` or
 *     a secret compared inside `keyAccepted()` counts where the wrapper is
 *     called, and a helper that reads a document before the gate is a data
 *     touch where IT is called.
 *  2. EVERYTHING BEFORE THE GATE IS ACCOUNTED FOR. A call to a function
 *     imported from this repository that runs before the gate must be in
 *     `PURE`, with the reason it touches no document, and the claim is
 *     checked against the function's own body: an entry whose function
 *     contains a Firestore touch fails. A package import (`next/server`,
 *     `node:crypto`, `google-auth-library`) cannot reach this app's Firestore
 *     without the handle and is not classified.
 *  3. THE REFUSAL COMES FIRST TOO. When the gate is a session gate and the
 *     handler refuses a missing session at its top level, that refusal has to
 *     sit before the first data touch as well. A handler that resolves the
 *     session, reads the document and only then refuses has answered whether
 *     the document exists to a caller with no session.
 *  4. THE PUBLIC ROUTES ARE WRITTEN DOWN. A handler with no gate before its
 *     first touch is in `PUBLIC` with the reason and the literal that stands
 *     in for the gate (a throttle, a signed token verified inside a helper,
 *     a read that only ever returns published documents). Both directions:
 *     an entry whose handler has since gained a gate fails as stale.
 *
 * WHAT IT CANNOT SEE. Per-document authorisation (is this caller on this
 * event's `collaboratorUids`) necessarily happens after the read, and this
 * guard does not ask that the ROLE check precede the read either: only that
 * the caller's identity is established first. `tests/authority-at-use.test.mjs`
 * owns what happens with the array once it is read, and
 * `tests/public-write-gating.test.mjs` owns whether an anonymous caller is
 * refused at all. The source proof of a `PURE` entry is one level deep: it
 * reads the named function's body, not the bodies of what that function
 * calls, which is why `assertNotImpersonating` can sit in the list although
 * the session helper it delegates to reads the user's document. The scanner's
 * own reading is exercised on synthetic handlers at the bottom of this file,
 * so a pattern that quietly stopped matching fails rather than passes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";
import {
  UNREADABLE_EXPORT,
  assertReadableSource,
  balancedParens,
  braceDepths,
  exportedHandlers,
  moduleScope,
  readsAsAbsence,
  walkRoutes,
} from "./lib/routeScan.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "src");
const API_DIR = join(SRC_DIR, "app", "api");

// ---------------------------------------------------------------------------
// The registries
// ---------------------------------------------------------------------------

/**
 * A function whose return value is proof of who is calling. `session` marks
 * the ones that resolve a signed-in account (and so are subject to the
 * refusal-order check); the others prove a presented credential.
 */
const GATES = {
  getCurrentUser: {
    from: "@/lib/firebase/session",
    session: true,
    proves: "a verified session cookie, with the live role read off the user's document",
  },
  getSessionUid: {
    from: "@/lib/firebase/session",
    session: true,
    proves: "a verified session cookie, uid only, for the registration routes that run before a users document exists",
  },
  getLiveImpersonator: {
    from: "@/lib/firebase/impersonation",
    session: true,
    proves: "the view-as marker paired with the session behind it, for the routes that behave differently inside view-as",
  },
  requireApplicant: {
    from: ["@/lib/admissions/applicantSession", "@/lib/admissions/applyContext"],
    session: true,
    proves: "a signed-in account that is not rejected, the applicant lane's bar",
  },
  gateRunStaff: {
    from: "@/lib/email/courseFacilitatorEmails",
    session: true,
    proves: "a session that is admin or on the run's staff; the run is read inside the gate and the refusal is returned rather than thrown",
  },
  gateGroupRegister: {
    from: "@/lib/courses/registerAccess",
    session: true,
    proves: "a session that may take a group's register; missing, archived and not-yours collapse onto one refusal inside it",
  },
  verifyToken: {
    from: "@/lib/signedTokens",
    session: false,
    proves: "an HMAC-signed token with the scope and expiry the route asked for",
  },
  verifyRecaptcha: {
    from: "@/lib/recaptcha/server",
    session: false,
    proves: "a reCAPTCHA token Google accepted, which fails closed in production when the secret is absent",
  },
  timingSafeEqual: {
    from: "node:crypto",
    session: false,
    proves: "a presented secret compared in constant time: the scheduler key and the webhook signature",
  },
};

/** Gates that are METHODS on an SDK object rather than bare calls. */
const METHOD_GATES = {
  verifyIdToken: "a Firebase or Google id token verified by the SDK, on the sign-in routes",
  timingSafeEqual:
    "the same constant-time compare through a namespace import (`crypto.timingSafeEqual`), on the webhook",
};

/** A method call that reaches Firestore. */
const DATA_METHODS = new Set([
  "collection",
  "collectionGroup",
  "doc",
  "runTransaction",
  "batch",
  "getAll",
  "bulkWriter",
]);

/**
 * Functions imported from this repository that a handler may call before its
 * gate, each with the reason it touches no document. The claim is checked:
 * the function's own body must contain no Firestore method.
 */
const PURE = {
  assertNotImpersonating: {
    from: "@/lib/firebase/impersonation",
    why: "reads the view-as cookie and, only when one is present, the session behind it; no resource document",
  },
  isAddressableId: {
    // The shared module, plus the inline copies tests/api-addressable-ids.test.mjs
    // lists for burn-down; each copy's body is read here as well.
    from: ["@/lib/addressableId", "@/lib/courses/registerAccess", "@/lib/worksheets/access", "@/lib/email/courseFacilitatorEmails"],
    why: "a string test on the path segment, run before anything so a separator never reaches a document path",
  },
  getAdminDb: {
    from: "@/lib/firebase/admin",
    why: "obtains the Firestore handle; nothing is read until a method is called on it",
  },
  getAdminAuth: {
    from: "@/lib/firebase/admin",
    why: "obtains the Auth handle, on the sign-in route that verifies the id token with it",
  },
  rateLimit: {
    from: "@/lib/rateLimit",
    why: "an in-memory fixed-window counter, deliberately not Firestore-backed",
  },
  clientIp: {
    from: "@/lib/rateLimit",
    why: "reads the forwarded-for header",
  },
  throttleIp: {
    from: "@/lib/admissions/applyContext",
    why: "the admissions wrapper around the in-memory limiter, returning the 429 to send",
  },
  isPushConfigured: {
    from: "@/lib/push/config",
    why: "reads the VAPID keys out of the environment",
  },
  isAcademicEmail: {
    from: "@/lib/firestore/users",
    why: "a domain pattern test on an address",
  },
  isNottinghamEmail: {
    from: "@/lib/firestore/users",
    why: "a domain pattern test on an address",
  },
  recaptchaBypassGranted: {
    from: "@/lib/recaptcha/bypass",
    why: "compares a presented header to an environment secret and tests the address against the harness namespace",
  },
};

/**
 * Handlers that touch Firestore with no gate before them, or touch nothing.
 *
 * `gate` is a literal that must appear in the file (comments stripped, strings
 * kept), naming what stands in for the gate; `touches` says what the handler
 * does to Firestore so a reader knows what the missing gate exposes. An entry
 * is checked in both directions: a handler that has since gained a gate
 * before its first touch fails here as stale.
 */
const PUBLIC = new Map([
  [
    "src/app/api/events/[id]/calendar.ics/route.ts#GET",
    {
      touches: "reads one event",
      gate: "getPublishedEvent(",
      why:
        "The public calendar feed for a published event, reachable from the public event page. " +
        "The read helper is the gate: it returns only a published, unarchived event, and the " +
        "location line goes through the disclosure helper so a hidden location is never in it.",
    },
  ],
  [
    "src/app/api/register/resend/route.ts#POST",
    {
      touches: "reads and updates the caller's own unverified registration row, by address",
      gate: "rateLimit(`resend:ip:${ip}`",
      why:
        "Re-sends a verification link to an address that is mid-registration, so there is no " +
        "session to require. The per-IP throttle runs before the read and every outcome is " +
        "answered with one uniform body.",
    },
  ],
  [
    "src/app/api/subscriptions/route.ts#POST",
    {
      touches: "reads the suppression list and the subscription row, then writes the row",
      gate: "rateLimit(`subscriptions:ip:${ip}`",
      why:
        "The public subscribe form. The session lookup that follows the reads is not a gate: it " +
        "only upgrades a signed-in caller to inbox-proven. The per-IP throttle and the " +
        "per-address cooldown run first, and an anonymous caller gets the same body whatever " +
        "the row held.",
    },
  ],
  [
    "src/app/api/auth/session/clear/route.ts#POST",
    {
      touches: "nothing",
      gate: "clearSessionCookieOnly(",
      why:
        "Clears the caller's own session cookie without revoking anything, for a client whose " +
        "Firebase Auth state and cookie have drifted apart. There is no document to protect.",
    },
  ],
  [
    "src/app/api/admin/impersonate/exit/route.ts#POST",
    {
      touches: "reads and closes one view-as audit row",
      gate: "getImpersonator(",
      why:
        "RECORDED, NOT BLESSED. The exit route reads the audit row named by an unsigned cookie " +
        "before any session check, saved only by an equality test on a 20-character auto id. " +
        "It is the audit's own low finding with its own line on the hardening queue, and it is " +
        "listed here so every run reports it rather than a future reader assuming it was " +
        "considered and approved.",
    },
  ],
]);

/**
 * Handlers that touch Firestore before their gate ON PURPOSE, through a
 * helper this scan cannot see into, with the touch named. Checked both ways:
 * the helper must still be called before the gate, or the entry is stale.
 */
const TOUCHES_BEFORE_GATE = new Map([
  [
    "src/app/api/register/route.ts#POST",
    {
      calls: "recordSignupOutcome",
      touches: "increments the signup funnel's aggregate outcome counter",
      why:
        "The registration funnel counts malformed submissions by design, so the invalid-email " +
        "outcome is recorded before the captcha is spent on it. The counter is an aggregate " +
        "with no caller-controlled field and no PII, the per-IP throttle runs before it, and " +
        "every path that records it answers the same 400.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const CALL = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
const METHOD_CALL = /\.([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * The first gate and the first data touch in a body, read in call order.
 *
 * Returns `{ gate, data, unresolved }`, each `{ at, name }` or null, where
 * `at` is an offset into `body`. A local helper's own events are folded in
 * at the offset of the call to it. `unresolved` is the first call, before the
 * gate, to a repository import that is neither a gate nor in PURE.
 */
function readBody(body, scope, seen = new Set()) {
  const events = [];
  CALL.lastIndex = 0;
  let match;
  while ((match = CALL.exec(body)) !== null) {
    events.push({ at: match.index, name: match[1], method: false });
  }
  METHOD_CALL.lastIndex = 0;
  while ((match = METHOD_CALL.exec(body)) !== null) {
    events.push({ at: match.index, name: match[1], method: true });
  }
  events.sort((a, b) => a.at - b.at);

  let gate = null;
  let data = null;
  let unresolved = null;
  const gatesSeen = new Set();
  // A helper's events are folded in at the offset of the call to it, kept in
  // their own order by a fraction of one character, so a helper that verifies
  // a token and then reads is still read as gate-then-data.
  const fold = (at, inner, length) => at + inner.at / (length + 1);
  for (const event of events) {
    if (event.method) {
      if (event.name in METHOD_GATES) {
        gatesSeen.add(`.${event.name}`);
        if (!gate) gate = { at: event.at, name: `.${event.name}`, session: false };
      } else if (!data && DATA_METHODS.has(event.name)) {
        data = { at: event.at, name: `.${event.name}(` };
      }
      continue;
    }
    if (event.name in GATES) {
      gatesSeen.add(event.name);
      if (!gate) gate = { at: event.at, name: event.name, session: GATES[event.name].session };
      continue;
    }
    if (scope.locals.has(event.name) && !seen.has(event.name)) {
      const span = scope.locals.get(event.name);
      const inner = readBody(span.text, scope, new Set([...seen, event.name]));
      for (const g of inner.gatesSeen) gatesSeen.add(g);
      if (!gate && inner.gate) {
        gate = {
          at: fold(event.at, inner.gate, span.text.length),
          name: `${event.name} -> ${inner.gate.name}`,
          session: inner.gate.session,
        };
      }
      if (!data && inner.data) {
        data = { at: fold(event.at, inner.data, span.text.length), name: `${event.name} -> ${inner.data.name}` };
      }
      if (!gate && !unresolved && inner.unresolved) {
        unresolved = {
          at: fold(event.at, inner.unresolved, span.text.length),
          name: `${event.name} -> ${inner.unresolved.name}`,
        };
      }
      continue;
    }
    if (gate) continue;
    const specifier = scope.imports.get(event.name);
    if (!specifier) continue; // a global, a parameter, or a local variable
    if (!isRepositoryModule(specifier)) continue; // a package cannot reach Firestore on its own
    if (event.name in PURE) continue;
    if (!unresolved) unresolved = { at: event.at, name: `${event.name} (${specifier})` };
  }
  return { gate, data, unresolved, gatesSeen };
}

function isRepositoryModule(specifier) {
  return specifier.startsWith("@/") || specifier.startsWith(".");
}

/**
 * The variables a handler holds a session in, and the offset of its first
 * top-level refusal keyed on one of them being absent. Null when the handler
 * never refuses at its top level, which is `tests/public-write-gating.test.mjs`'s
 * question rather than this one's.
 */
function refusalOffset(body, scope, seen = new Set()) {
  const sessionLocals = [...scope.locals.keys()].filter(
    (name) => !seen.has(name) && readBody(scope.locals.get(name).text, scope).gate?.session,
  );
  const gateNames = [
    ...Object.entries(GATES).filter(([, g]) => g.session).map(([name]) => name),
    ...sessionLocals,
  ];
  const assignment = new RegExp(
    `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:${gateNames.join("|")})\\s*\\(`,
    "g",
  );
  const variables = [];
  let assigned;
  while ((assigned = assignment.exec(body)) !== null) variables.push(assigned[1]);

  const candidates = [];
  if (variables.length > 0) {
    const depths = braceDepths(body);
    const ifs = /\bif\s*\(/g;
    let branch;
    while ((branch = ifs.exec(body)) !== null) {
      if (depths[branch.index] !== 0) continue;
      const paren = body.indexOf("(", branch.index);
      const condition = balancedParens(body, paren);
      const refuses = variables.some(
        (v) => readsAsAbsence(condition, v) || new RegExp(`!\\s*${v}\\s*\\.\\s*ok\\b`).test(condition),
      );
      if (!refuses) continue;
      if (!/\breturn\b/.test(body.slice(paren, paren + 400))) continue;
      candidates.push(branch.index);
      break;
    }
  }
  // A wrapper that refuses inside itself refuses where it is called, kept in
  // its own order the way readBody folds a wrapper's read.
  for (const name of sessionLocals) {
    const call = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).exec(body);
    if (!call) continue;
    const span = scope.locals.get(name);
    const inner = refusalOffset(span.text, scope, new Set([...seen, name]));
    if (inner !== null) candidates.push(call.index + inner / (span.text.length + 1));
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** Every handler under src/app/api with what the scan found. */
function scanTree() {
  const handlers = [];
  const unreadable = [];
  for (const file of walkRoutes(API_DIR)) {
    const raw = readFileSync(file, "utf8");
    const source = stripSource(raw);
    const path = relative(REPO_ROOT, file).split("\\").join("/");
    assertReadableSource(raw, source, path);
    if (UNREADABLE_EXPORT.test(source)) {
      unreadable.push(`${path} (a handler is exported in a form this scan cannot read)`);
    }
    const scope = moduleScope(source, stripSource(raw, { keepStrings: true }));
    for (const handler of exportedHandlers(source)) {
      if (!handler.span) {
        unreadable.push(`${path}#${handler.method}`);
        continue;
      }
      const body = handler.span.text;
      const read = readBody(body, scope);
      handlers.push({
        key: `${path}#${handler.method}`,
        path,
        scope,
        body,
        ...read,
        refusalAt: refusalOffset(body, scope),
      });
    }
  }
  return { handlers, unreadable };
}

/**
 * Comment-free source WITH its strings, for the literals PUBLIC names: they
 * are calls whose argument is a template the scanner's own reading empties.
 */
const withStrings = (path) =>
  stripSource(readFileSync(join(REPO_ROOT, path), "utf8"), { keepStrings: true });

/** Resolve a repository specifier to a file, the way the loader does. */
function resolveModule(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC_DIR, specifier.slice(2))
    : join(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** The stripped body of `name` as defined in `file`, or null. */
function bodyOfExport(file, name) {
  const raw = readFileSync(file, "utf8");
  const scope = moduleScope(stripSource(raw), stripSource(raw, { keepStrings: true }));
  return scope.locals.get(name)?.text ?? null;
}

function touchesData(body) {
  METHOD_CALL.lastIndex = 0;
  let match;
  while ((match = METHOD_CALL.exec(body)) !== null) {
    if (DATA_METHODS.has(match[1])) return `.${match[1]}(`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const { handlers, unreadable } = scanTree();

describe("every handler proves the caller before it touches Firestore", () => {
  test("the scan could read every route in the tree", () => {
    assert.deepEqual(
      unreadable,
      [],
      "A handler this scan cannot read is a handler it cannot check. Use `export async " +
        "function METHOD`, or teach tests/lib/routeScan.mjs the new form.",
    );
    assert.ok(handlers.length > 150, `only ${handlers.length} handlers found under src/app/api`);
  });

  test("the first gate comes before the first read or write, or the handler is in PUBLIC", () => {
    const failures = [];
    for (const h of handlers) {
      const listed = PUBLIC.has(h.key);
      const gated = h.gate && (!h.data || h.gate.at < h.data.at);
      if (gated) {
        if (listed) {
          failures.push(
            `${h.key} is in PUBLIC but ${h.gate.name} now runs before ${h.data?.name ?? "any touch"}. ` +
              "Delete the entry.",
          );
        }
        continue;
      }
      if (listed) continue;
      if (h.gate && h.data) {
        failures.push(
          `${h.key} touches Firestore (${h.data.name}) before its gate (${h.gate.name}). Move the ` +
            "gate above the read, or add a PUBLIC entry with the reason.",
        );
      } else if (h.data) {
        failures.push(
          `${h.key} touches Firestore (${h.data.name}) and calls no recognised gate. Add one from ` +
            "GATES before the read, or add a PUBLIC entry with the reason.",
        );
      } else {
        failures.push(
          `${h.key} calls no recognised gate and this scan sees no Firestore touch either. Add ` +
            "a PUBLIC entry saying what it does, or a gate if it does more than the scan sees.",
        );
      }
    }
    assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  });

  test("every repository function called before the gate is in PURE", () => {
    const failures = [];
    for (const h of handlers) {
      if (PUBLIC.has(h.key)) continue;
      const accounted = TOUCHES_BEFORE_GATE.get(h.key);
      if (accounted) {
        const called = new RegExp(`(?<![\\w$.])${accounted.calls}\\s*\\(`).exec(h.body);
        assert.ok(
          called && (!h.gate || called.index < h.gate.at),
          `TOUCHES_BEFORE_GATE names ${h.key} calling ${accounted.calls} before its gate, which it ` +
            "no longer does. Delete the entry.",
        );
        assert.ok(accounted.why.length > 60, `TOUCHES_BEFORE_GATE["${h.key}"] needs a reason.`);
      }
      if (!h.unresolved) continue;
      if (h.gate && h.unresolved.at > h.gate.at) continue;
      if (accounted && h.unresolved.name.startsWith(`${accounted.calls} (`)) continue;
      failures.push(
        `${h.key} calls ${h.unresolved.name} before its gate. If it touches no document, add it ` +
          "to PURE with the reason; if it reads one, move the gate above it.",
      );
    }
    assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  });

  test("a top-level refusal of a missing session sits before the first read or write", () => {
    const failures = [];
    for (const h of handlers) {
      if (PUBLIC.has(h.key)) continue;
      if (!h.gate?.session) continue;
      if (h.refusalAt === null || !h.data) continue;
      if (h.refusalAt < h.data.at) continue;
      failures.push(
        `${h.key} reads (${h.data.name}) before it refuses a missing session at its top level. ` +
          "A caller with no session learns whether the document exists. Move the refusal up.",
      );
    }
    assert.deepEqual(failures, [], `\n${failures.join("\n")}\n`);
  });
});

describe("the registries are real in both directions", () => {
  test("every gate in GATES decides at least one handler, and comes from where it says", () => {
    const used = new Set();
    for (const h of handlers) for (const g of h.gatesSeen) used.add(g);
    for (const [name, gate] of Object.entries(GATES)) {
      assert.ok(
        used.has(name),
        `GATES.${name} is called by no handler. Delete it, or the tree has stopped using it.`,
      );
      assert.ok(gate.proves.length > 30, `GATES.${name} needs a written account of what it proves.`);
      const specifiers = new Set();
      for (const h of handlers) {
        const spec = h.scope.imports.get(name);
        if (spec) specifiers.add(spec);
      }
      const allowed = [gate.from].flat();
      const elsewhere = [...specifiers].filter((spec) => !allowed.includes(spec));
      assert.deepEqual(
        elsewhere,
        [],
        `GATES.${name} says it comes from ${allowed.join(" or ")}; the tree also imports it from ${elsewhere.join(", ")}.`,
      );
    }
    for (const name of Object.keys(METHOD_GATES)) {
      assert.ok(used.has(`.${name}`), `METHOD_GATES.${name} is called by no handler.`);
    }
  });

  test("every PURE entry is called before a gate somewhere, and its body touches no document", () => {
    const usedBefore = new Set();
    for (const h of handlers) {
      if (PUBLIC.has(h.key)) continue;
      const limit = h.gate ? h.gate.at : h.body.length;
      const before = h.body.slice(0, limit);
      // Locals that run before the gate are read as well, so a PURE helper
      // called from inside a wrapper is credited.
      const texts = [before];
      for (const [name, span] of h.scope.locals) {
        if (new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(before)) texts.push(span.text);
      }
      for (const text of texts) {
        for (const match of text.matchAll(CALL)) {
          if (match[1] in PURE && h.scope.imports.has(match[1])) usedBefore.add(match[1]);
        }
      }
    }
    for (const [name, entry] of Object.entries(PURE)) {
      assert.ok(
        usedBefore.has(name),
        `PURE.${name} is called before a gate by no handler. Delete the entry.`,
      );
      assert.ok(entry.why.length > 25, `PURE.${name} needs a written reason.`);
      const allowed = [entry.from].flat();
      const files = new Set();
      for (const h of handlers) {
        const spec = h.scope.imports.get(name);
        if (!spec) continue;
        assert.ok(
          allowed.includes(spec),
          `PURE.${name} says ${allowed.join(" or ")}; ${h.path} imports it from ${spec}.`,
        );
        files.add(resolveModule(spec, join(REPO_ROOT, h.path)));
      }
      for (const file of files) {
        assert.ok(file, `PURE.${name}: one of ${[entry.from].flat().join(", ")} does not resolve to a file.`);
        const body = bodyOfExport(file, name);
        assert.ok(
          body !== null,
          `PURE.${name}: no function of that name is defined in ${relative(REPO_ROOT, file)}, so ` +
            "its purity cannot be read. Point the entry at the defining module.",
        );
        const touch = touchesData(body);
        assert.equal(
          touch,
          null,
          `PURE.${name} in ${relative(REPO_ROOT, file)} touches Firestore (${touch}). It is not pure: ` +
            "remove the entry and move the gate above the call.",
        );
      }
    }
  });

  test("every PUBLIC entry names a handler, a reason and a literal the file carries", () => {
    const keys = new Set(handlers.map((h) => h.key));
    for (const key of TOUCHES_BEFORE_GATE.keys()) {
      assert.ok(keys.has(key), `TOUCHES_BEFORE_GATE names ${key}, which is not a handler in the tree.`);
    }
    for (const [key, entry] of PUBLIC) {
      assert.ok(keys.has(key), `PUBLIC names ${key}, which is not a handler in the tree.`);
      assert.ok(entry.why.length > 60, `PUBLIC["${key}"] needs a reason a reader can check.`);
      assert.ok(entry.touches.length > 5, `PUBLIC["${key}"] must say what it touches.`);
      const [path] = key.split("#");
      assert.ok(
        withStrings(path).includes(entry.gate),
        `PUBLIC["${key}"] names ${JSON.stringify(entry.gate)}, which ${path} does not contain.`,
      );
    }
  });
});

describe("the scanner's own reading", () => {
  const scope = (source) =>
    moduleScope(stripSource(source), stripSource(source, { keepStrings: true }));

  test("a gate before a read is gated; a read before a gate is not", () => {
    const gatedFirst = readBody(
      `const user = await getCurrentUser(); if (!user) return x; const s = await db.collection("t").doc(id).get();`,
      scope(""),
    );
    assert.equal(gatedFirst.gate?.name, "getCurrentUser");
    assert.ok(gatedFirst.gate.at < gatedFirst.data.at);

    const readFirst = readBody(
      `const s = await db.collection("t").doc(id).get(); const user = await getCurrentUser();`,
      scope(""),
    );
    assert.ok(readFirst.data.at < readFirst.gate.at);
  });

  test("a gate inside a local helper counts where the helper is called, and so does a read", () => {
    const wrapperSource = `
async function requireEnroller() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({}, { status: 401 });
  return user;
}
async function loadThing(db, id) {
  return db.collection("things").doc(id).get();
}
`;
    const s = scope(wrapperSource);
    const viaWrapper = readBody(`const caller = await requireEnroller(); const t = await loadThing(db, id);`, s);
    assert.equal(viaWrapper.gate?.name, "requireEnroller -> getCurrentUser");
    assert.equal(viaWrapper.data?.name, "loadThing -> .collection(");
    assert.ok(viaWrapper.gate.at < viaWrapper.data.at);

    const readViaHelperFirst = readBody(`const t = await loadThing(db, id); const c = await requireEnroller();`, s);
    assert.ok(readViaHelperFirst.data.at < readViaHelperFirst.gate.at);
  });

  test("a repository import before the gate is unresolved unless PURE; a package import is not", () => {
    const s = scope(`import { readThing } from "@/lib/firestore/things";
import { isAddressableId } from "@/lib/addressableId";
import { randomBytes } from "node:crypto";`);
    const unresolved = readBody(`const t = await readThing(id); const u = await getCurrentUser();`, s);
    assert.equal(unresolved.unresolved?.name, "readThing (@/lib/firestore/things)");
    const pure = readBody(`if (!isAddressableId(id)) return x; randomBytes(8); const u = await getCurrentUser();`, s);
    assert.equal(pure.unresolved, null);
    const after = readBody(`const u = await getCurrentUser(); const t = await readThing(id);`, s);
    assert.equal(after.unresolved, null, "a call after the gate needs no classification");
  });

  test("a method gate and a secret compare are both gates", () => {
    const s = scope(`function keyAccepted(req) { return timingSafeEqual(a, b); }`);
    assert.equal(readBody(`if (!keyAccepted(req)) return notFound();`, s).gate?.name, "keyAccepted -> timingSafeEqual");
    assert.equal(readBody(`const d = await auth.verifyIdToken(t);`, s).gate?.name, ".verifyIdToken");
  });

  test("the refusal offset is the first top-level absence check, and a nested one does not count", () => {
    const s = scope("");
    const topLevel = `const user = await getCurrentUser();\nif (!user) { return x; }\nconst s = await db.collection("t").doc(id).get();`;
    const at = refusalOffset(topLevel, s);
    assert.ok(at !== null && at < topLevel.indexOf(".collection("));
    const nested = `const user = await getCurrentUser();\nconst s = await db.collection("t").doc(id).get();\nif (s.exists) { if (!user) return x; }`;
    assert.equal(refusalOffset(nested, s), null);
    const late = `const user = await getCurrentUser();\nconst s = await db.collection("t").doc(id).get();\nif (!user) return x;`;
    const lateAt = refusalOffset(late, s);
    assert.ok(lateAt !== null && lateAt > late.indexOf(".collection("));
  });
});
