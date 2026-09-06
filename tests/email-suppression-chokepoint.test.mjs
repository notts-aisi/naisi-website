/**
 * The suppression list is consulted at ONE place, and nothing can post mail
 * around it.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## The defect this exists for
 *
 * `sendEmail()` in `src/lib/email/send.ts` used only to log. Whether a
 * hard-bounced or complained address was spared depended on the CALLER
 * remembering `isSuppressed()` first, and about twenty routes calling
 * `sendEmail()` directly did not: register and its resend, the university
 * email links, every task notification, the application emails and their test
 * send, subscriptions and their confirmation, the event cancel and broadcast,
 * the course group notice, the newsletter send and its test, the admin test
 * email, the worksheet reminders. Every one of them would mail an address the
 * provider had already told us not to write to, which is how a sending domain
 * loses its reputation.
 *
 * The fix moved the check into `sendEmail()`. The rule that replaces "remember
 * to check" is "there is one door", so this file guards the door on three
 * levels:
 *
 *  1. by SOURCE, that the check happens before the message is handed over;
 *  2. by WALKING `src`, that no other file builds a transporter of its own, so
 *     the door cannot be walked around;
 *  3. by EXECUTION, that a suppressed recipient is really dropped, really
 *     leaves an `emailSends` row saying so, and that an all-suppressed send
 *     never touches the provider at all.
 *
 * The third is the one that would catch a check that runs and then ignores its
 * own answer, which no source grep can see.
 *
 * Faked for (3): `nodemailer`, `@react-email/render`, `server-only` and
 * `@/lib/firebase/admin`. The Firestore helpers underneath (`filterSuppressed`,
 * `logEmailSend`, `logSuppressedSend`) are the REAL ones, run against a fake
 * db, because the shape of the row they write is half of what is being
 * asserted. Nothing here can reach a Firestore project or an SMTP server.
 */
import { test } from "node:test";
import { createLoader } from "./lib/tsLoader.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const SEND = join(SRC, "lib", "email", "send.ts");

const rel = (file) => relative(REPO_ROOT, file).split("\\").join("/");

/** Every .ts / .tsx file under src, so the walk cannot miss a new one. */
function sourceFiles(dir = SRC, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/* -------------------------------------------------------------------------
 * 1. The door itself
 * ---------------------------------------------------------------------- */

test("sendEmail consults the suppression list before it hands anything to the provider", () => {
  const source = readFileSync(SEND, "utf8");

  assert.match(
    source,
    /import\s*\{\s*filterSuppressed\s*\}\s*from\s*["']@\/lib\/firestore\/suppression["']/,
    "src/lib/email/send.ts no longer imports filterSuppressed. It is the only place the " +
      "suppression list is read on the send path; without it every caller is back to " +
      "remembering, which is the defect this replaced.",
  );

  const checkAt = source.indexOf("filterSuppressed(db,");
  const sendAt = source.indexOf("transporter().sendMail(");
  const renderAt = source.indexOf("render(react)");
  assert.ok(checkAt > 0, "sendEmail does not call filterSuppressed(db, ...).");
  assert.ok(sendAt > 0, "sendEmail no longer calls transporter().sendMail(); re-read this file.");
  assert.ok(
    checkAt < sendAt,
    "sendEmail hands the message to the provider before it reads the suppression list. " +
      "The list has to decide who is left BEFORE anything is posted, or the row it " +
      "writes is an apology rather than a guard.",
  );
  assert.ok(
    renderAt === -1 || checkAt < renderAt,
    "sendEmail renders the email before it reads the suppression list. Rendering for " +
      "recipients who will all be dropped is work nobody asked for.",
  );

  assert.match(
    source,
    /logSuppressedSend\(/,
    "a dropped recipient must leave an emailSends row at status `suppressed`, or the " +
      "deliverability tab shows a gap where a withheld message was and nobody can " +
      "answer why a member did not get their email.",
  );
});

/* -------------------------------------------------------------------------
 * 2. There is no second door
 * ---------------------------------------------------------------------- */

test("nothing in src posts mail except through sendEmail", () => {
  const importsNodemailer = /from\s*["']nodemailer["']|require\(\s*["']nodemailer["']\s*\)/;
  const buildsTransport = /createTransport\s*\(/;

  const senders = [];
  const callers = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (importsNodemailer.test(source) || buildsTransport.test(source)) senders.push(file);
    // `sendEmailVerification(` is Firebase Auth's own and not this path: the
    // "(" is what keeps it out.
    if (file !== SEND && /\bsendEmail\(/.test(source)) callers.push(file);
  }

  assert.deepEqual(
    senders.map(rel),
    ["src/lib/email/send.ts"],
    "a file other than src/lib/email/send.ts builds its own mail transport. That is a " +
      "second way out of this product that the suppression list does not see. Send " +
      "through sendEmail() instead, or this guard is measuring one of two doors.",
  );

  assert.ok(
    callers.length > 15,
    `only ${callers.length} caller(s) of sendEmail were found under src. The walk has ` +
      "stopped seeing them, so this test is asserting about almost nothing.",
  );
  for (const file of callers) {
    assert.ok(
      !importsNodemailer.test(readFileSync(file, "utf8")),
      `${rel(file)} calls sendEmail AND imports nodemailer. One of the two is a bypass.`,
    );
  }
});

/* -------------------------------------------------------------------------
 * 3. The decision, executed
 * ---------------------------------------------------------------------- */

/**
 * The stubs the send path needs to run in-process. `firebase-admin` never
 * appears here because `send.ts` reaches Firestore only through `getAdminDb`,
 * which this replaces outright, and the two Firestore helpers underneath
 * import it for TYPES alone.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "nodemailer",
    "export default {\n" +
      "  createTransport: () => ({\n" +
      "    sendMail: async (message) => {\n" +
      "      globalThis.__sentMail.push(message);\n" +
      "      return { messageId: '<test@naisi.uk>', response: '250 Ok' };\n" +
      "    },\n" +
      "  }),\n" +
      "};",
  ],
  ["@react-email/render", "export const render = async () => 'rendered';"],
  ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
]);

// The shared loader (tests/lib/tsLoader.mjs): one compiler, JSX on, per-suite
// stubs. A hand copy here would be the forty-fourth and the guard in
// tests/ts-loader.test.mjs refuses it.
const { loadTs } = createLoader({ stubs: STUBS });

async function loadSend() {
  return loadTs(SEND);
}

/**
 * A Firestore small enough to read: doc-id lookups into `suppressedEmails`
 * (which is all `filterSuppressed` does) and `add` into `emailSends`.
 */
function makeDb(suppressedAddresses) {
  const docId = (email) =>
    email.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, "_");
  const suppressed = new Set(suppressedAddresses.map(docId));
  const rows = [];
  return {
    collection(name) {
      return {
        doc: (id) => ({ collection: name, id }),
        async add(doc) {
          assert.equal(name, "emailSends", `unexpected write to ${name}`);
          rows.push({ ...doc });
          return { id: `row-${rows.length}` };
        },
      };
    },
    async getAll(...refs) {
      return refs.map((ref) => {
        assert.equal(ref.collection, "suppressedEmails", `unexpected read of ${ref.collection}`);
        return { exists: suppressed.has(ref.id), id: ref.id };
      });
    },
    rows,
  };
}

function arm(db) {
  globalThis.__db = db;
  globalThis.__sentMail = [];
  process.env.SMTP_HOST = "smtp.test.invalid";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_USER = "harness@test.invalid";
  process.env.SMTP_PASSWORD = "not-a-real-password";
  process.env.SMTP_FROM_EMAIL = "hello@naisi.uk";
  process.env.SMTP_FROM_NAME = "NAISI";
}

const { sendEmail } = await loadSend();

test("an all-suppressed send never reaches the provider, and says what it withheld", async () => {
  const db = makeDb(["bounced@e2e.invalid"]);
  arm(db);

  const result = await sendEmail({
    to: "Bounced@e2e.invalid",
    subject: "Your application",
    react: {},
    kind: "application",
    actorUid: "admin-1",
    referenceId: "round-7",
  });

  assert.deepEqual(globalThis.__sentMail, [], "a suppressed address was handed to the provider.");
  assert.equal(result.messageId, "", "nothing was sent, so there is no provider id.");
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(result.suppressed, ["Bounced@e2e.invalid"]);

  assert.equal(db.rows.length, 1, "the withheld message left no row, so it is invisible.");
  const [row] = db.rows;
  assert.equal(row.status, "suppressed");
  assert.equal(row.to, "Bounced@e2e.invalid", "the row keeps the address as it was addressed.");
  assert.equal(row.subject, "Your application");
  assert.equal(row.kind, "application", "the row carries the kind the send would have carried.");
  assert.equal(row.actorUid, "admin-1");
  assert.equal(row.referenceId, "round-7");
  assert.ok(row.statusReason, "a held row must say why it was held.");
  assert.ok(!("messageId" in row), "nothing was posted, so a provider id would be a fiction.");
});

test("a mixed send goes to the clear addresses only, and logs both outcomes", async () => {
  const db = makeDb(["complained@e2e.invalid"]);
  arm(db);

  const result = await sendEmail({
    to: ["keep@e2e.invalid", "complained@e2e.invalid", "also@e2e.invalid"],
    subject: "Week 3 is up",
    react: {},
    kind: "course-nudge",
  });

  assert.equal(globalThis.__sentMail.length, 1, "one message for the addresses that remained.");
  assert.equal(
    globalThis.__sentMail[0].to,
    "keep@e2e.invalid, also@e2e.invalid",
    "the suppressed address is still on the envelope, so the drop is cosmetic.",
  );
  assert.deepEqual(result.delivered, ["keep@e2e.invalid", "also@e2e.invalid"]);
  assert.deepEqual(result.suppressed, ["complained@e2e.invalid"]);
  assert.equal(result.messageId, "<test@naisi.uk>");

  const byStatus = (status) => db.rows.filter((r) => r.status === status).map((r) => r.to).sort();
  assert.deepEqual(byStatus("sent"), ["also@e2e.invalid", "keep@e2e.invalid"]);
  assert.deepEqual(byStatus("suppressed"), ["complained@e2e.invalid"]);
});

test("a clear send is unchanged: one message, one row per recipient", async () => {
  const db = makeDb([]);
  arm(db);

  const result = await sendEmail({
    to: ["one@e2e.invalid", "two@e2e.invalid"],
    subject: "Nothing to hold back",
    react: {},
  });

  assert.equal(globalThis.__sentMail.length, 1);
  assert.equal(globalThis.__sentMail[0].to, "one@e2e.invalid, two@e2e.invalid");
  assert.deepEqual(result.suppressed, []);
  assert.deepEqual(result.delivered, ["one@e2e.invalid", "two@e2e.invalid"]);
  assert.equal(db.rows.length, 2);
  assert.ok(db.rows.every((r) => r.status === "sent" && r.kind === "unknown"));
});

test("addressing nobody is the caller's bug, not a silent hold", async () => {
  arm(makeDb([]));
  await assert.rejects(
    () => sendEmail({ to: "   ", subject: "x", react: {} }),
    /no recipient address/,
    "an empty address returned quietly, which reads exactly like `everybody was " +
      "suppressed` and is not that at all.",
  );
  assert.deepEqual(globalThis.__sentMail, []);
});

test("every walked source file is readable", () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, "the src walk found almost nothing.");
  for (const file of files.slice(0, 5)) assert.ok(statSync(file).isFile());
});
