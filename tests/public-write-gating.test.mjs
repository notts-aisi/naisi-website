/**
 * AN ENDPOINT A STRANGER CAN DRIVE TO A SIDE EFFECT IS GATED LIKE ONE.
 *
 * WHY. `POST /api/events/[id]/rsvp` accepted a submission from anybody on the
 * internet and answered it by writing an `eventRsvps` row and posting a
 * NAISI-branded email, from the society's own sending domain with real DKIM on
 * it, to an address the caller chose, carrying a greeting name and free-text
 * answers the caller also chose. It had no session requirement on a public
 * event, no reCAPTCHA and no throttle of any kind. A list of harvested
 * addresses and a loop was a spam run signed by the society, and the bounces
 * and complaints landed on its own sender reputation and suppression list.
 * Plus-addressing multiplied the per-address quota, and every further public
 * event multiplied it again, because the duplicate guard is per event. Found
 * by the events review on 9 September 2026 and fixed the way `/api/register`
 * was already gated: a per-IP throttle before any document is read, a
 * per-address throttle after the format check, and reCAPTCHA.
 *
 * The class is wider than one route, so the guard walks the tree:
 *
 *  1. THE SCAN decides, per exported handler under `src/app/api`, whether an
 *     anonymous caller reaches its body. A handler is session-required only
 *     when a refusal keyed on an identity the session gate returned sits at
 *     the TOP LEVEL of the handler. The RSVP route is the reason that word is
 *     there: it called `getCurrentUser`, and refused a missing session only
 *     inside `if (visibility === "members")`, so a checker that asked whether
 *     the file mentions a session at all would have called it gated.
 *  2. THE REGISTRY answers for each one what it does and what gates it, with a
 *     written reason. Both directions. A handler the scan calls
 *     anonymous-reachable and the registry does not name FAILS, so a new
 *     public route arrives already having to answer the question.
 *  3. THE RULE. An anonymous handler that SENDS to a caller-chosen address
 *     carries a rate limit, and either a captcha or a per-address cooldown
 *     that bounds how often one address can be written to. One that WRITES
 *     carries a rate limit or a credential the caller had to present. Every
 *     literal named is checked against the file rather than believed.
 *
 * The runtime half is `scripts/e2e/tests/public-write-gating.test.mjs`, which
 * asks a deployed backend whether the RSVP captcha is really live, the same
 * way `recaptcha-gate.test.mjs` asks it of `/api/register`. A gate that is
 * configured out of existence on one backend is invisible to a source scan.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadable, stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(REPO_ROOT, "src", "app", "api");

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** Every method Next will route to a handler. */
const HTTP_METHOD = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/** The session gates a handler can hold an identity from. */
const SESSION_GATES = [
  "getCurrentUser",
  "getSessionUid",
  "requireApplicant",
  "requireAdminPage",
  "requireCourseAuthorPage",
  "requireAdmissionsPage",
  "requireMembershipPage",
];

const ASSIGNMENT = new RegExp(
  `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:${SESSION_GATES.join("|")})\\s*\\(`,
  "g",
);

const HANDLER = new RegExp(`export\\s+async\\s+function\\s+(${HTTP_METHOD})\\s*\\(`, "g");

function* walkRoutes(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkRoutes(full);
    else if (entry === "route.ts") yield full;
  }
}

/** The balanced `(...)` starting at `openIdx`, without its brackets. */
function balancedParens(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return "";
}

/**
 * The body of the handler whose `export async function` starts at `from`.
 *
 * The parameter list is skipped FIRST. `ctx: { params: Promise<{ id: string }> }`
 * puts a brace before the body, and taking that brace reads a type literal as
 * the handler: every route in the tree then looked ungated, which is the shape
 * of failure a guard must not have.
 */
function handlerBody(source, from) {
  const paren = source.indexOf("(", from);
  if (paren < 0) return null;
  let depth = 0;
  let afterParams = -1;
  for (let i = paren; i < source.length; i++) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        afterParams = i;
        break;
      }
    }
  }
  if (afterParams < 0) return null;
  const open = source.indexOf("{", afterParams);
  if (open < 0) return null;
  depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** Brace depth at each character of `body`, relative to the handler's own body. */
function braceDepths(body) {
  const depths = new Array(body.length);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") {
      depths[i] = depth;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      depths[i] = depth;
    } else {
      depths[i] = depth;
    }
  }
  return depths;
}

/**
 * Does this condition read as "there is no session"?
 *
 * The shapes the tree actually uses: a negation, a null comparison, a refusal
 * object the gate returned (`gate.error`, `"error" in gate`), and the
 * `instanceof NextResponse` the applicant gate uses. Deliberately NOT "the
 * condition mentions the variable": `if (viewer.role === "admin")` mentions it
 * and is a branch, not a refusal, and treating a branch as a gate is the
 * direction that hides an open route.
 */
function readsAsAbsence(condition, variable) {
  const v = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\w.])!\\s*${v}\\b` +
      `|\\b${v}\\s*={2,3}\\s*null\\b` +
      `|\\b${v}\\s*\\.\\s*error\\b` +
      `|""\\s+in\\s+${v}\\b` +
      `|\\b${v}\\s+instanceof\\b`,
  ).test(condition);
}

/**
 * Every exported handler under `src/app/api` an anonymous caller reaches,
 * keyed `path#METHOD`.
 */
/**
 * A handler exported in a form the scan cannot read.
 *
 * Next accepts several: `export const POST = ...`, `export { handler as POST }`,
 * `export { POST }` after a local declaration, `export { POST } from "./x"` and
 * `export * from "./x"`. This scan only understands `export async function`,
 * which is what all 170 route files use today, and a route that used another
 * form would be invisible to it rather than reported by it. So the form itself
 * is checked, in every one of those spellings and for `HEAD` and `OPTIONS` as
 * well: a handler exported any other way fails here, and whoever wrote it
 * decides between changing the form and teaching the scanner.
 */
const UNREADABLE_EXPORT = new RegExp(
  [
    // export const POST = ...
    `export\\s+(?:const|let|var)\\s+(?:${HTTP_METHOD})\\b`,
    // export { handler as POST } / export { POST } / export { POST } from "..."
    `export\\s*\\{[^}]*\\b(?:${HTTP_METHOD})\\b[^}]*\\}`,
    // export * from "./handlers"
    `export\\s*\\*\\s*from`,
  ].join("|"),
);

export function scanAnonymousHandlers() {
  const anonymous = new Set();
  const unreadable = [];
  for (const file of walkRoutes(API_DIR)) {
    const raw = readFileSync(file, "utf8");
    const source = stripSource(raw);
    const path = relative(REPO_ROOT, file).split("\\").join("/");
    assertReadableSource(raw, source, path);
    if (UNREADABLE_EXPORT.test(source)) {
      unreadable.push(`${path} (a handler is exported in a form this scan cannot read)`);
    }
    const identities = new Set();
    ASSIGNMENT.lastIndex = 0;
    let assigned;
    while ((assigned = ASSIGNMENT.exec(source)) !== null) identities.add(assigned[1]);

    HANDLER.lastIndex = 0;
    let handler;
    while ((handler = HANDLER.exec(source)) !== null) {
      const body = handlerBody(source, handler.index);
      if (body === null) {
        unreadable.push(`${path}#${handler[1]}`);
        continue;
      }
      const depths = braceDepths(body);
      let gated = false;
      const ifs = /\bif\s*\(/g;
      let branch;
      while ((branch = ifs.exec(body)) !== null) {
        if (depths[branch.index] !== 0) continue; // nested: conditional on something else
        const paren = body.indexOf("(", branch.index);
        const condition = balancedParens(body, paren);
        if (![...identities].some((v) => readsAsAbsence(condition, v))) continue;
        // The refusal has to actually leave. `if (!user) user = anon;` is not
        // a gate.
        if (!/\breturn\b/.test(body.slice(paren, paren + 400))) continue;
        gated = true;
        break;
      }
      if (!gated) anonymous.add(`${path}#${handler[1]}`);
    }
  }
  return { anonymous, unreadable };
}

/**
 * A route that reads as almost nothing has not been read. Collected into
 * `unreadable` rather than thrown, so the failure names every file at once.
 */
function assertReadableSource(raw, source, path) {
  const codeLines = source.split("\n").filter((line) => line.trim().length > 0).length;
  if (codeLines === 0 || source.length < Math.min(200, raw.length) * 0.02) {
    throw new Error(
      `${path} read as ${source.length} characters out of ${raw.length}. The source reader ` +
        "has desynced; see tests/lib/stripSource.mjs.",
    );
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One entry per handler the scan reaches without a session.
 *
 *  - `anonymous: false` the scan cannot see this handler's gate, because it
 *    sits inside a helper in the same file. `gatedBy` names a literal that
 *    must be there, and the file must carry a 401. Reported rather than
 *    resolved, because resolving a gate through a helper is the
 *    gate-before-data guard's job and duplicating half of it here would leave
 *    two answers to one question.
 *  - `anonymous: true` a stranger reaches the body. Then:
 *      `sends`      it posts a message to an address the caller can choose.
 *                   Needs `throttle`, and `captcha` or `cooldown`.
 *      `writes`     it changes a document. Needs `throttle` or `credential`.
 *      neither      read-only, or it only touches the caller's own cookie.
 *
 * Every literal named is checked against the file.
 */
const PUBLIC_HANDLERS = new Map([
  // --- the route this guard was written for --------------------------------
  [
    "src/app/api/events/[id]/rsvp/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      throttle: "rateLimit(`events:rsvp:ip:${ip}`",
      captcha: "verifyRecaptcha(recaptchaToken)",
      why:
        "The public RSVP. A stranger chooses the address, the greeting name and the free-text " +
        "answers, and an accepted submission writes a row and posts a NAISI-branded email to " +
        "that address. Gated on 9 September 2026 the way /api/register is: the per-IP " +
        "throttle runs before the session lookup and before any document is read, the " +
        "per-address throttle after the format check, and reCAPTCHA before the event is " +
        "fetched.",
    },
  ],

  // --- the other public writers, each already gated ------------------------
  [
    "src/app/api/register/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      throttle: "rateLimit(`register:ip:${ip}`",
      captcha: "verifyRecaptcha(recaptchaToken)",
      why:
        "Account creation from an address a stranger types. The pattern every other public " +
        "writer here is measured against.",
    },
  ],
  [
    "src/app/api/register/resend/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      throttle: "rateLimit(`resend:ip:${ip}`",
      cooldown: "COOLDOWN_SECONDS",
      why:
        "Re-sends a verification link. No captcha, and that is a decision rather than an " +
        "oversight: it can only ever mail an address that already has an unverified " +
        "registration row, so it addresses nobody new, and it answers every outcome with one " +
        "uniform body. Both throttle axes run before the Firestore read.",
    },
  ],
  [
    "src/app/api/subscriptions/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      throttle: "rateLimit(`subscriptions:ip:${ip}`",
      cooldown: "COOLDOWN_SECONDS",
      why:
        "The public subscribe form. It mails a confirmation to an address a stranger types, " +
        "which is the RSVP shape, and it carries a per-IP throttle and a sixty-second " +
        "per-(address, channel) cooldown but NO captcha. Recorded rather than blessed: a " +
        "captcha here is on the hardening queue, and until it lands the cooldown is what " +
        "bounds one address to one message a minute while the rate limit bounds the spread.",
    },
  ],

  // --- credentials: the caller presented something --------------------------
  [
    "src/app/api/events/[id]/rsvp/[rsvpId]/cancel/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      credential: "verifyRsvpToken",
      why:
        "An attendee freeing their own place from the link in their confirmation email. The " +
        "signed token IS the credential, and it names one RSVP row, so there is no address " +
        "for a caller to choose.",
    },
  ],
  [
    "src/app/api/events/[id]/rsvp/[rsvpId]/request-change/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      credential: "verifyRsvpToken",
      why:
        "The same signed token on the same row, asking an organiser for a change rather than " +
        "cancelling. The token names the row, so there is no address to choose.",
    },
  ],
  [
    "src/app/api/unsubscribe/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: false,
      credential: "verifyToken",
      why:
        "The signed unsubscribe link. POST commits, because a mail scanner that fetches URLs " +
        "must not unsubscribe somebody on their behalf.",
    },
  ],
  [
    "src/app/api/unsubscribe/route.ts#GET",
    {
      anonymous: true,
      writes: false,
      sends: false,
      why:
        "The preview page behind the same link. It renders a confirm form and writes nothing, " +
        "which is what stops an inbox scanner unsubscribing the recipient on their behalf.",
    },
  ],
  [
    "src/app/api/subscriptions/confirm/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      credential: "verifyToken",
      why:
        "The double opt-in commit, behind the signed token from the confirmation email. Split " +
        "from its GET on 9 September 2026 for the same scanner reason as the unsubscribe link.",
    },
  ],
  [
    "src/app/api/subscriptions/confirm/route.ts#GET",
    {
      anonymous: true,
      writes: false,
      sends: false,
      why:
        "The preview half of the same link. It reads the token and renders a confirm button, " +
        "and changes nothing: a mail scanner that fetches URLs must not opt somebody in.",
    },
  ],
  [
    "src/app/api/verify-email/confirm/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: false,
      credential: "confirmUniEmailVerification(",
      why:
        "The university-email magic link. The token is the credential, and since 9 September " +
        "2026 the confirming request must ALSO be the account the token was minted for, which " +
        "is checked inside `confirmUniEmailVerification` rather than here.",
    },
  ],
  [
    "src/app/api/webhooks/resend-events/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: false,
      credential: "verifySvixSignature(",
      why:
        "The delivery webhook. The signature is the credential; an unsigned request is refused " +
        "before anything is read. `tests/webhook-verification.test.mjs` is the guard for that " +
        "class, after an orphaned unsigned webhook was deleted on 8 September 2026.",
    },
  ],
  [
    "src/app/api/scheduler/tick/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: true,
      credential: "SCHEDULER_SECRET",
      why:
        "The scheduler's own door, opened by a shared secret Cloud Scheduler presents on every " +
        "tick. Nothing about the request comes from a person.",
    },
  ],
  [
    "src/app/api/auth/session/route.ts#POST",
    {
      anonymous: true,
      writes: false,
      sends: false,
      credential: "verifyIdToken",
      why:
        "Mints the session cookie from a Firebase ID token. The token is the credential, and " +
        "it must be anonymous-reachable: it is how a session begins.",
    },
  ],
  [
    "src/app/api/auth/session/route.ts#DELETE",
    {
      anonymous: true,
      writes: false,
      sends: false,
      why:
        "Signing out. It clears the caller's own cookie and, outside a view-as session, revokes " +
        "their own refresh tokens. Nothing another person holds is touched.",
    },
  ],
  [
    "src/app/api/auth/session/clear/route.ts#POST",
    {
      anonymous: true,
      writes: false,
      sends: false,
      why:
        "Clears a stale cookie so a broken session can be recovered from. It writes no " +
        "document and revokes nothing, which is the whole reason it is separate from DELETE " +
        "above.",
    },
  ],
  [
    "src/app/api/auth/google/callback/route.ts#POST",
    {
      anonymous: true,
      writes: false,
      sends: false,
      credential: "verifyIdToken({",
      why:
        "The Google sign-in callback. It reads the posted credential, checks the CSRF " +
        "double-submit cookie and verifies the token against Google's keys, then hands it on " +
        "in a cookie. No document is written and no message is sent, and it must be reachable " +
        "without a session because it is how one begins.",
    },
  ],
  [
    "src/app/api/events/[id]/calendar.ics/route.ts#GET",
    {
      anonymous: true,
      writes: false,
      sends: false,
      why:
        "The public calendar feed for a published event. Read-only, and what it says about a " +
        "hidden location is `tests/event-location-disclosure.test.mjs`'s subject.",
    },
  ],
  [
    "src/app/api/admin/impersonate/exit/route.ts#POST",
    {
      anonymous: true,
      writes: true,
      sends: false,
      credential: "getImpersonator",
      why:
        "RECORDED, NOT BLESSED. This is the only route in the /api/admin tree with no " +
        "server-side identity check: it stamps `endedAt` on an `impersonations` audit row on " +
        "the strength of an unsigned cookie, saved only by an equality check on a 20-character " +
        "auto id the caller would have to know. It is a LOW finding on the security hardening " +
        "queue with its own line, and the fix is the two lines every sibling has. This entry " +
        "exists so the guard reports it on every run rather than a future reader assuming it " +
        "was considered and approved.",
    },
  ],

  // --- gated inside a helper the scan cannot follow -------------------------
  [
    "src/app/api/admin/members/[uid]/conduct-flag/route.ts#GET",
    {
      anonymous: false,
      gatedBy: "requireAdmin(",
      why: "Admin only, through a helper in the file that returns the refusal rather than throwing.",
    },
  ],
  [
    "src/app/api/admin/members/[uid]/conduct-flag/route.ts#POST",
    {
      anonymous: false,
      gatedBy: "requireAdmin(",
      why: "The same helper on the write that records a conduct flag against a member.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/attendance/route.ts#POST",
    {
      anonymous: false,
      gatedBy: "gateGroupRegister(",
      why: "The register gate refuses a missing session before anything is marked.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/attendance/route.ts#PATCH",
    {
      anonymous: false,
      gatedBy: "gateGroupRegister(",
      why: "The same gate on the edit of an attendance mark that is already recorded.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/email/route.ts#POST",
    {
      anonymous: false,
      gatedBy: "gateRunStaff(",
      refusedIn: "src/lib/email/courseFacilitatorEmails.ts",
      why:
        "Only a run's staff may address it. The gate is shared with the nudge routes and " +
        "returns the refusal rather than throwing, which is why the status codes live there.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/nudge/route.ts#GET",
    {
      anonymous: false,
      gatedBy: "gateRunStaff(",
      refusedIn: "src/lib/email/courseFacilitatorEmails.ts",
      why: "The same gate on the read that fills the weekly nudge composer with its recipients.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/nudge/route.ts#POST",
    {
      anonymous: false,
      gatedBy: "gateRunStaff(",
      refusedIn: "src/lib/email/courseFacilitatorEmails.ts",
      why: "The same gate on the send that puts the weekly nudge in front of a run's members.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/enrol/route.ts#GET",
    {
      anonymous: false,
      gatedBy: '{ error: "Not signed in." }, { status: 401 }',
      why:
        "A helper in the file refuses a missing session before the run is read, which is why " +
        "the scan cannot see the gate from the handler itself. It also carries its own per-IP " +
        "and per-uid throttles.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/enrol/route.ts#POST",
    {
      anonymous: false,
      gatedBy: '{ error: "Not signed in." }, { status: 401 }',
      why:
        "The same helper on the enrol write, refusing before a seat is minted or a place is " +
        "taken from the run's capacity.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/enrol/route.ts#PATCH",
    {
      anonymous: false,
      gatedBy: '{ error: "Not signed in." }, { status: 401 }',
      why:
        "The same helper on the change of an existing enrolment, refusing before the seat or " +
        "the group is touched.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/enrol/route.ts#DELETE",
    {
      anonymous: false,
      gatedBy: '{ error: "Not signed in." }, { status: 401 }',
      why:
        "The same helper on the withdrawal from a run, refusing before the seat is released " +
        "back to the pool.",
    },
  ],
]);

/**
 * Comment-free source WITH its strings, because every literal the registry
 * names is a call whose argument is a string or a template
 * (`rateLimit(\`events:rsvp:ip:${ip}\`)`), and the scanner's own reading empties
 * exactly those. Comments still go, so a gate mentioned in prose does not
 * count as a gate.
 */
const withStrings = (file) =>
  stripSource(readFileSync(join(REPO_ROOT, file), "utf8"), { keepStrings: true });

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("every anonymous-reachable handler is registered", () => {
  const { anonymous, unreadable } = scanAnonymousHandlers();

  test("the scan could read every route in the tree", () => {
    assert.deepEqual(
      unreadable,
      [],
      "A handler could not be read. Report it rather than skipping it: a route the scanner " +
        "cannot read is a route nothing here asks about. Either write the handler as " +
        "`export async function`, which all 170 routes do today, or teach the scan the form.",
    );
    assert.ok(anonymous.size > 0, "The scan found no anonymous handlers at all, which cannot be right.");
  });

  test("both directions", () => {
    const missing = [...anonymous].filter((key) => !PUBLIC_HANDLERS.has(key)).sort();
    assert.deepEqual(
      missing,
      [],
      "A handler under src/app/api has no top-level refusal for a missing session and no entry " +
        "in PUBLIC_HANDLERS. Say what it does and what gates it. If its gate is inside a helper " +
        "the scan cannot follow, say `anonymous: false` and name the literal.",
    );
    const stale = [...PUBLIC_HANDLERS.keys()].filter((key) => !anonymous.has(key)).sort();
    assert.deepEqual(
      stale,
      [],
      "PUBLIC_HANDLERS names a handler the scan now considers session-required. Either it " +
        "grew a gate and the entry should go, or the scanner changed and that needs looking at.",
    );
  });

  test("every entry gives a written reason", () => {
    for (const [key, entry] of PUBLIC_HANDLERS) {
      assert.ok(
        typeof entry.why === "string" && entry.why.trim().length >= 60,
        `${key} needs a real reason, not a placeholder.`,
      );
    }
  });
});

describe("a handler declared gated names the gate, and the file carries it", () => {
  for (const [key, entry] of PUBLIC_HANDLERS) {
    if (entry.anonymous !== false) continue;
    test(key, () => {
      const [path] = key.split("#");
      const raw = readFileSync(join(REPO_ROOT, path), "utf8");
      const source = withStrings(path);
      assertReadable(raw, source, path, assert);
      assert.ok(typeof entry.gatedBy === "string", `${key} must name the literal that gates it.`);
      assert.ok(
        source.includes(entry.gatedBy),
        `${key} says it is gated by ${JSON.stringify(entry.gatedBy)}, which is not in ${path}.`,
      );
      // The refusal has to exist somewhere, and `refusedIn` says where: the
      // route itself for an in-file helper, or the shared module the gate
      // lives in. 401 OR 403, because several gates in this tree collapse
      // "not signed in" and "not allowed" onto one answer deliberately, so an
      // anonymous caller does not learn the endpoint is worth a session.
      const refusedIn = entry.refusedIn ?? path;
      const refusalSource = withStrings(refusedIn);
      assert.ok(
        /\b40[13]\b/.test(refusalSource),
        `${key} claims a session gate in ${refusedIn}, which never answers 401 or 403. A gate ` +
          "that refuses nobody is not a gate.",
      );
    });
  }
});

describe("an anonymous handler with a side effect is gated for one", () => {
  for (const [key, entry] of PUBLIC_HANDLERS) {
    if (entry.anonymous !== true) continue;
    test(key, () => {
      const [path] = key.split("#");
      const raw = readFileSync(join(REPO_ROOT, path), "utf8");
      const source = withStrings(path);
      assertReadable(raw, source, path, assert);

      for (const [field, value] of Object.entries(entry)) {
        if (!["throttle", "captcha", "cooldown", "credential", "gatedBy"].includes(field)) continue;
        assert.ok(
          source.includes(value),
          `${key} names ${field} as ${JSON.stringify(value)}, which is not in ${path}. A gate ` +
            "the registry claims and the file does not have is worse than no entry at all.",
        );
      }

      if (entry.sends) {
        const bounded = Boolean(entry.credential) || Boolean(entry.throttle);
        assert.ok(
          bounded,
          `${key} posts a message and a stranger reaches it, with no throttle and no ` +
            "credential. That is an outbound mailer signed by the society.",
        );
        if (!entry.credential) {
          assert.ok(
            entry.captcha || entry.cooldown,
            `${key} lets a stranger choose who receives a message, with a rate limit and ` +
              "nothing else. A rate limit caps the rate; a captcha or a per-address cooldown " +
              "is what stops one caller addressing a list. Name whichever it carries.",
          );
        }
      }

      if (entry.writes) {
        assert.ok(
          entry.credential || entry.throttle,
          `${key} changes a document and a stranger reaches it, with neither a credential nor ` +
            "a throttle.",
        );
      }

      if (!entry.writes && !entry.sends) {
        assert.ok(
          /read|clear|preview|render|feed|cookie|token/i.test(entry.why),
          `${key} claims no side effect, and the reason should say what it does instead.`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------

describe("the scanner still tells a gate from a branch", () => {
  const wrap = (body) =>
    `export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {${body}}`;

  const isAnonymous = (body) => {
    const source = wrap(body);
    const identities = new Set();
    ASSIGNMENT.lastIndex = 0;
    let assigned;
    while ((assigned = ASSIGNMENT.exec(source)) !== null) identities.add(assigned[1]);
    HANDLER.lastIndex = 0;
    const handler = HANDLER.exec(source);
    const inner = handlerBody(source, handler.index);
    assert.ok(inner !== null, "the fixture handler body must be readable");
    const depths = braceDepths(inner);
    const ifs = /\bif\s*\(/g;
    let branch;
    while ((branch = ifs.exec(inner)) !== null) {
      if (depths[branch.index] !== 0) continue;
      const paren = inner.indexOf("(", branch.index);
      const condition = balancedParens(inner, paren);
      if (![...identities].some((v) => readsAsAbsence(condition, v))) continue;
      if (!/\breturn\b/.test(inner.slice(paren, paren + 400))) continue;
      return false;
    }
    return true;
  };

  test("a top-level refusal is a gate", () => {
    assert.equal(
      isAnonymous("const viewer = await getCurrentUser(); if (!viewer) return refuse();"),
      false,
    );
    assert.equal(
      isAnonymous("const caller = await requireApplicant(); if (caller instanceof NextResponse) return caller;"),
      false,
    );
    assert.equal(
      isAnonymous("const user = await getCurrentUser(); if (!user || !canDoIt(user)) return refuse();"),
      false,
    );
  });

  test("a refusal nested in another condition is NOT a gate", () => {
    // The RSVP route's exact shape, and the reason the depth check exists.
    assert.equal(
      isAnonymous(
        "const viewer = await getCurrentUser();" +
          " if (visibility === 'members') { if (!viewer) return refuse(); }" +
          " await write();",
      ),
      true,
    );
  });

  test("a branch that mentions the session is not a refusal", () => {
    assert.equal(
      isAnonymous("const viewer = await getCurrentUser(); if (viewer.role === 'admin') return everything();"),
      true,
    );
  });

  test("a condition with no return is not a refusal", () => {
    assert.equal(isAnonymous("const viewer = await getCurrentUser(); if (!viewer) { log('anon'); }"), true);
  });

  test("a parameter list with a brace in it does not swallow the handler", () => {
    const source = wrap("const viewer = await getCurrentUser(); if (!viewer) return refuse();");
    const body = handlerBody(source, 0);
    assert.match(body, /getCurrentUser/, "the body must start after the parameter list");
    assert.doesNotMatch(body, /Promise</, "the parameter type must not be read as the body");
  });
});
