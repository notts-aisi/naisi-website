/**
 * The attendance register, end to end, in a real browser.
 *
 * The group page -> mark all five states -> flip a session to not held -> write
 * a participant note -> push the first session -> press push again from a tab
 * that had not heard -> correct a pushed mark as an admin -> force the resend
 * -> read what actually went out.
 *
 * ## How to run it
 *
 *   node scripts/run-e2e.mjs --spec register-push --local
 *   E2E_TARGET=http://127.0.0.1:3100 node scripts/run-e2e.mjs --spec register-push
 *
 * `scripts/run-e2e.mjs` seeds the throwaway world, leaves its ids in a state
 * file under `.e2e-state/` (or wherever E2E_STATE_DIR points), and tears
 * everything down afterwards. Running this file on its own is supported but
 * only once a seed exists: it reads the state file and skips loudly when there
 * is none.
 *
 * ## IT SIGNS IN AS THE OWNER'S ADMIN, AND THAT IS THE POINT
 *
 * Every door onto a register is facilitator-or-admin, and this harness may not
 * appoint a facilitator (`facilitatorUids` is empty in the fixture, and the
 * fence in tests/funnel-harness-guards.test.mjs keeps it that way). So the
 * journey is the admin's, on the admin branch of the same gate.
 *
 * One consequence is worth stating rather than glossing: an admin's cells stay
 * EDITABLE after a push (`canEditPushed`), so this spec cannot watch the
 * facilitator's cells turn to stone. What it asserts instead is the boundary
 * itself, in three parts: the draft-only controls disappear from a pushed
 * column (counted before the push as well as after, so the check can fail);
 * the draft lane REFUSES a write to a pushed register even for this admin,
 * which the spec proves by issuing the POST the UI will not let it click and
 * reading the 409 back; and the admin's next correction travels the PATCH
 * lane, leaving an audit row saying who moved what.
 *
 * ## CHROMIUM ONLY
 *
 * Playwright drives Chromium here and nothing else, so a green run is a
 * regression net rather than a substitute for the manual Safari pass.
 *
 * ## It writes a completion marker, and the runner insists on it
 *
 * Every way this file can decline to run (no Playwright, no fixture, a skip)
 * still exits `node --test` at 0. The shared recorder records each step as it
 * finishes and writes the list in the `finally`; the runner refuses to report
 * success unless the marker names every step in `SPEC.steps`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertTarget, loadSecrets } from "../../scripts/e2e/lib/env.mjs";
import {
  createStepRecorder,
  openBrowser,
  signInWithPassword,
  stubRecaptchaOnLoopback,
} from "../../scripts/e2e/lib/browser.mjs";
import {
  ARTIFACTS_DIR,
  RECAPTCHA_SKIP_REASON,
  enrolmentId,
  fixtureDoc,
  fixtureQuery,
  markerPath,
  statePath,
  stateDir,
} from "../../scripts/e2e-fixtures/core.mjs";
import {
  NEXT_WEEK,
  NOTE_WEEK,
  NOT_HELD_WEEK,
  PUSH_WEEK,
  RECAPTCHA_DEPENDENT_STEPS,
  SPEC,
  weekDocId,
} from "../../scripts/e2e-fixtures/register-push.mjs";

const RUN_STATE_DIR = stateDir();
const STATE_PATH = statePath(SPEC.name, RUN_STATE_DIR);
const MARKER = markerPath(SPEC.name, RUN_STATE_DIR);

/** Every locator waits at most this long. Generous: a dev server compiles a
 *  page on its first request. */
const WAIT_MS = 30_000;

/**
 * Why a step may not run in this mode, or null. Nothing on this journey is
 * reCAPTCHA-gated, so `SPEC.recaptchaDependentSteps` is empty and this never
 * fires; the wiring is the funnel's, kept verbatim so that a control which
 * grows a gate later is one line away from being declared.
 */
let skipReasonFor = () => null;

/**
 * The one reason this file may record for a step it did not run, shared with
 * the runner through `core.mjs`.
 */
const DEPLOYED_TARGET_SKIP = RECAPTCHA_SKIP_REASON;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Playwright is NOT a dependency of this repo (the root manifest is on the
 * production deploy's `npm ci` path), so it is resolved at runtime and a
 * missing one is a SKIP with the install line, not a red suite.
 */
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

/**
 * The attendance states the product declares, in order, as the labels a cell
 * announces.
 *
 * READ OFF THE SOURCE rather than restated, the way the harness guard computes
 * the current policy version out of policies.ts. This spec's second step
 * claims to take EVERY state, and a hand-written list of five would go on
 * claiming that after a sixth was added: the step would still pass, still be
 * called "all five attendance states", and quietly cover one fewer than the
 * register offers. Read here so the claim fails when it stops being true.
 *
 * A regex over TypeScript rather than an import, because this file is plain
 * Node with no build step in front of it. Both blocks are plain literal lists,
 * and a shape this cannot parse throws with the line to look at rather than
 * returning a short list.
 */
function declaredStatusLabels() {
  const source = readFileSync(
    new URL("../../src/lib/firestore/courseAttendance.ts", import.meta.url),
    "utf8",
  );
  const order = /ATTENDANCE_STATUSES:\s*AttendanceStatus\[\]\s*=\s*\[([\s\S]*?)\];/.exec(source);
  assert.ok(
    order,
    "could not read ATTENDANCE_STATUSES out of src/lib/firestore/courseAttendance.ts. " +
      "The list moved or changed shape: point this reader at it again.",
  );
  const labelBlock =
    /ATTENDANCE_STATUS_LABEL:\s*Record<AttendanceStatus,\s*string>\s*=\s*\{([\s\S]*?)\};/.exec(
      source,
    );
  assert.ok(
    labelBlock,
    "could not read ATTENDANCE_STATUS_LABEL out of src/lib/firestore/courseAttendance.ts.",
  );
  const labels = new Map();
  for (const [, key, label] of labelBlock[1].matchAll(/"?([a-z-]+)"?\s*:\s*"([^"]+)"/g)) {
    labels.set(key, label);
  }
  return [...order[1].matchAll(/"([^"]+)"/g)].map(([, status]) => {
    const label = labels.get(status);
    assert.ok(label, `ATTENDANCE_STATUS_LABEL carries no label for ${JSON.stringify(status)}`);
    return label;
  });
}

const state = loadState();
const playwright = await loadPlaywright();
const secrets = loadSecrets();

const skipReason = !playwright
  ? "Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium"
  : !state
    ? `No register fixture at ${STATE_PATH}. Run: node scripts/run-e2e.mjs --spec register-push.`
    : !secrets.adminEmail || !secrets.adminPassword
      ? "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are not set. This journey is the admin's, and this harness cannot create an admin."
      : null;

/**
 * The origin under test, through the auth harness's own allowlist so a typo
 * cannot aim a run that WRITES REGISTERS AND SENDS MAIL at production.
 */
function baseUrl() {
  return assertTarget(process.env.E2E_TARGET ?? "https://dev.naisi.uk");
}

// `skipReason ?? false`, never `skipReason`: node:test reads the PRESENCE of a
// `skip` key, so a null there labels a fully successful run `# SKIP`.
test(
  "register push: mark, flip, note, push, re-press, correct, resend",
  { skip: skipReason ?? false },
  async (t) => {
    const origin = baseUrl();
    const groupUrl = `${origin}/learn/${encodeURIComponent(state.runId)}/group/${encodeURIComponent(state.groupId)}`;
    /** True when this run's mail is caught by Mailpit rather than suppressed. */
    const mailFlows = state.suppress === false;

    const { browser, context, page } = await openBrowser();
    const recorder = createStepRecorder({
      t,
      page,
      markerPath: MARKER,
      artifactsDir: ARTIFACTS_DIR,
      skipReasonFor: (name) => skipReasonFor(name),
    });
    const step = (name, fn) => recorder.step(name, fn);
    const recaptchaStubbed = await stubRecaptchaOnLoopback(page, origin);
    if (!recaptchaStubbed) {
      skipReasonFor = (name) =>
        RECAPTCHA_DEPENDENT_STEPS.includes(name) ? DEPLOYED_TARGET_SKIP : null;
    }
    console.log(
      `[register-spec] mail ${mailFlows ? "is caught by Mailpit, so the reminder really sends" : "is suppressed, so nothing may send"}.`,
    );

    // ---- Locators, one place -----------------------------------------------

    /** The register table. Everything below is scoped inside it. */
    const gridOf = (p) => p.getByTestId("attendance-grid");
    /** One column's header, by session index (0 = week 1). */
    const headerOf = (p, index) => p.getByTestId("attendance-session").nth(index);
    /** One member's row, by the row order the fixture recorded. */
    const rowOf = (p, row) => gridOf(p).locator("tbody tr").nth(row);
    /** One cell's control: a button in an editable lane, a span in a locked one. */
    const cellOf = (p, row, col) => rowOf(p, row).getByTestId("attendance-cell").nth(col);
    const noteDotOf = (p, row, col) =>
      rowOf(p, row).getByTestId("attendance-note-open").nth(col);
    /**
     * The centre-screen action toast carrying one sentence.
     *
     * Matched by the sentence as well as the role, because `role="status"` with
     * `aria-live="polite"` is ALSO what `SavedFlash` renders, and it renders it
     * as an always-present empty span. A bare role locator therefore resolves
     * to that span first and never goes away, which is exactly how the first
     * version of this spec spent four steps waiting for a toast to disappear
     * that it had never been looking at.
     */
    const toastOf = (p, pattern) =>
      p.locator('[role="status"][aria-live="polite"]').filter({ hasText: pattern }).first();

    /**
     * The status a cell is showing, read off its accessible name.
     *
     * The name is what a screen reader announces ("Ada, week 1: Present. Sets
     * Late.") and is the same sentence in both lanes, so one reader covers a
     * markable cell and a locked one. Read rather than matched against the
     * glyph: the glyph is `aria-hidden` decoration and a test that asserted on
     * it would pass over a cell that said one thing and announced another.
     */
    async function statusOf(cell) {
      const label = (await cell.getAttribute("aria-label")) ?? "";
      const match = /week \d+: ([^.]+)\./.exec(label);
      assert.ok(match, `no status in the cell's accessible name: ${JSON.stringify(label)}`);
      return match[1];
    }

    /**
     * One tap on a cell, waiting for the route to answer.
     *
     * The grid is optimistic: the glyph moves on click whether or not the
     * write lands, so a spec that clicked and read the cell would pass over a
     * refused write every time. Waiting for the response is also what keeps
     * five taps in a row honest, since each one is a separate request and a
     * later one must not overtake an earlier one.
     *
     * `pathname` rather than a substring of the URL: `/attendance/push` also
     * contains `/attendance`, and the push is a different act.
     */
    async function tap(p, cell, { method = "POST" } = {}) {
      const [res] = await Promise.all([
        p.waitForResponse(
          (r) =>
            new URL(r.url()).pathname.endsWith("/attendance") &&
            r.request().method() === method,
          { timeout: WAIT_MS },
        ),
        cell.click(),
      ]);
      const body = await res.json().catch(() => null);
      assert.ok(
        res.ok() && body?.ok === true,
        `the register refused a ${method}: ${res.status()} ${JSON.stringify(body)}`,
      );
      return body;
    }

    /** Waits for the action toast to say something, then for it to go away. */
    async function readToast(p, pattern, run) {
      const said = toastOf(p, pattern);
      // Started BEFORE the press, not after: the toast holds a success message
      // for about a second and a wait that began afterwards can miss it.
      await Promise.all([said.waitFor({ timeout: WAIT_MS }), run()]);
      // The toast is a full-screen overlay while it is up, so anything clicked
      // before it goes hits the backdrop instead. Waiting it out here is what
      // lets the next step press a button. "hidden" rather than "detached":
      // both mean the sentence has gone, and only one of them is true of a
      // toast whose message changed rather than unmounting.
      await said.waitFor({ state: "hidden", timeout: WAIT_MS });
    }

    /** The register, reloaded from the server rather than from local state. */
    async function reload(p) {
      await p.reload({ waitUntil: "domcontentloaded" });
      await gridOf(p).waitFor({ timeout: WAIT_MS });
    }

    /** A second tab, same identity, for the stale-tab leg. Closed at the end. */
    let stale = null;

    try {
      await step("the admin opens the group page and sees the roster and the register", async () => {
        // The owner's own account: this harness cannot create an admin, and a
        // password is never logged. `signInWithPassword` in
        // scripts/e2e/lib/browser.mjs waits for the form to hydrate and the card
        // to land before it types, which this page's first load needs.
        await signInWithPassword(
          page,
          origin,
          { email: secrets.adminEmail, password: secrets.adminPassword },
          { timeout: WAIT_MS },
        );
        await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
        await page
          .getByRole("heading", { name: state.groupName })
          .first()
          .waitFor({ timeout: WAIT_MS });

        // The roster: three people, named, with no address anywhere near them.
        const roster = page.getByTestId("group-roster");
        await roster.waitFor({ timeout: WAIT_MS });
        const members = roster.getByRole("list", { name: "Members of this group" });
        await members.waitFor({ timeout: WAIT_MS });
        assert.equal(
          await members.getByRole("listitem").count(),
          state.members.length,
          "the roster did not list every seeded member",
        );
        await page.getByTestId("session-card").first().waitFor({ timeout: WAIT_MS });

        // The register: one column per session that has already started, which
        // for a run 22 days into a four-week plan is all four of them.
        await gridOf(page).waitFor({ timeout: WAIT_MS });
        assert.equal(
          await page.getByTestId("attendance-session").count(),
          state.weekCount,
          "the register did not offer a column for every session so far",
        );
        for (let week = 1; week <= state.weekCount; week += 1) {
          assert.match(
            (await headerOf(page, week - 1).innerText()).replace(/\s+/g, " "),
            new RegExp(`Week ${week}`),
            `column ${week} is not the week it should be`,
          );
        }
        assert.match(
          (await gridOf(page).locator("caption").innerText()).replace(/\s+/g, " "),
          new RegExp(`Attendance for ${state.groupName}`),
          "the register's caption did not name this group",
        );
      });

      await step("the register takes all five attendance states", async () => {
        // The cycle is present, late, left early, absent, excused, unmarked, so
        // the number of taps IS the state. Spread over two sessions and three
        // people, because a register is read across a row and down a column and
        // one cell carrying every state in turn would prove neither.
        const wanted = [
          { row: 0, col: 0, taps: 1, status: "Present" },
          { row: 1, col: 0, taps: 2, status: "Late" },
          { row: 2, col: 0, taps: 3, status: "Left early" },
          { row: 0, col: 1, taps: 4, status: "Absent" },
          { row: 1, col: 1, taps: 5, status: "Excused" },
        ];
        // The claim in this step's own name, checked against the product's
        // list rather than against itself. Ordered, so it also pins the tap
        // cycle: the nth tap on an unmarked cell lands on the nth declared
        // state, which is what the `taps` column above is counting.
        assert.deepEqual(
          wanted.map((mark) => mark.status),
          declaredStatusLabels(),
          "this step says it takes EVERY attendance state and the product's list has " +
            "moved. Give each new state a placement above (a row, a column and its tap " +
            "count), or drop the one that went, and rename the step if the count changed.",
        );
        for (const mark of wanted) {
          const cell = cellOf(page, mark.row, mark.col);
          for (let i = 0; i < mark.taps; i += 1) await tap(page, cell);
          assert.equal(
            await statusOf(cell),
            mark.status,
            `row ${mark.row}, column ${mark.col} did not land on ${mark.status}`,
          );
        }

        // RELOADED, so what is asserted is what the server stored rather than
        // what the optimistic grid drew.
        await reload(page);
        for (const mark of wanted) {
          assert.equal(
            await statusOf(cellOf(page, mark.row, mark.col)),
            mark.status,
            `${mark.status} did not survive a reload at row ${mark.row}, column ${mark.col}`,
          );
        }
        // The column the spec is about to push: everyone marked, so nobody is
        // about to be counted absent for want of a mark.
        assert.match(
          (await headerOf(page, PUSH_WEEK - 1).innerText()).replace(/\s+/g, " "),
          new RegExp(`${state.members.length}/${state.members.length}`),
          "the pushed column's tally does not say everyone is marked",
        );
      });

      await step("a session flipped to not held says so in its header", async () => {
        const header = headerOf(page, NOT_HELD_WEEK - 1);
        const toggle = header.getByTestId("attendance-held-toggle");
        await readToast(page, /did not happen/, async () => {
          await Promise.all([
            page.waitForResponse(
              (r) =>
                new URL(r.url()).pathname.endsWith("/attendance") &&
                r.request().method() === "POST",
              { timeout: WAIT_MS },
            ),
            toggle.click(),
          ]);
        });
        // The header is the whole point: a session that did not happen has to
        // read as one at a glance, or the register's denominators lie quietly.
        await header.getByText("Not held").waitFor({ timeout: WAIT_MS });
        await reload(page);
        await headerOf(page, NOT_HELD_WEEK - 1)
          .getByText("Not held")
          .waitFor({ timeout: WAIT_MS });
      });

      await step("a participant note saves and survives a reload", async () => {
        const note = `Register run ${state.registerRunId}: written by an automated run.`;
        await noteDotOf(page, 0, NOTE_WEEK - 1).click();
        const field = page.locator("#participant-note");
        await field.waitFor({ timeout: WAIT_MS });
        // The standing disclosure. It is the thing that keeps these notes worth
        // having, so its absence is a defect rather than a detail.
        await page
          .getByText(/personal data about a named student/)
          .first()
          .waitFor({ timeout: WAIT_MS });
        await field.fill(note);
        await Promise.all([
          page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname.endsWith("/participant-notes") &&
              r.request().method() === "POST",
            { timeout: WAIT_MS },
          ),
          page.getByRole("button", { name: "Save note" }).click(),
        ]);
        await field.waitFor({ state: "detached", timeout: WAIT_MS });

        // Reloaded before it is read back: saving merges the note into the
        // grid's local copy, so reopening the drawer without a reload would
        // read the browser's own answer rather than the server's.
        await reload(page);
        await noteDotOf(page, 0, NOTE_WEEK - 1).click();
        const reopened = page.locator("#participant-note");
        await reopened.waitFor({ timeout: WAIT_MS });
        assert.equal(await reopened.inputValue(), note, "the note did not come back");
        await page.getByRole("button", { name: "Cancel" }).click();
        await reopened.waitFor({ state: "detached", timeout: WAIT_MS });
      });

      await step("pushing the first session locks it and says who is emailed", async () => {
        // A SECOND TAB, opened while the register is still a draft and left
        // there. It is how the next step gets a second press: the grid is a
        // one-shot fetch with no listener (deliberately: "nothing moves behind
        // the facilitator's back"), so a tab open from before the push still
        // offers the button, which is exactly the person who presses twice
        // because the first press looked slow.
        stale = await context.newPage();
        await stale.goto(groupUrl, { waitUntil: "domcontentloaded" });
        await gridOf(stale).waitFor({ timeout: WAIT_MS });
        await headerOf(stale, PUSH_WEEK - 1)
          .getByTestId("attendance-push")
          .waitFor({ timeout: WAIT_MS });

        // COUNTED BEFORE THE PRESS, so the "they are gone" assertions at the
        // end of this step can actually fail. An earlier version looked for
        // the bulk button by the accessible name "Mark the remaining ...",
        // which it only carries while somebody is unmarked: step 2 marks all
        // three, so the name is "Week 1: All marked" both before the push and
        // after, and the check matched nothing in either state. Ids, and a
        // before.
        const draft = headerOf(page, PUSH_WEEK - 1);
        assert.equal(
          await draft.getByTestId("attendance-bulk").count(),
          1,
          "the draft column has no bulk mark button, so its absence after the push proves nothing",
        );
        assert.equal(
          await draft.getByTestId("attendance-push").count(),
          1,
          "the draft column has no push button, so its absence after the push proves nothing",
        );

        await headerOf(page, PUSH_WEEK - 1).getByTestId("attendance-push").click();
        const confirm = page.getByTestId("push-confirm");
        await confirm.waitFor({ timeout: WAIT_MS });
        const copy = (await confirm.innerText()).replace(/\s+/g, " ");
        // The three things the push does, in the words the dialog uses.
        assert.match(
          copy,
          new RegExp(`Everyone in ${state.groupName} gets one email about week ${NEXT_WEEK}`),
          `the confirm did not name who is emailed and what about: ${copy}`,
        );
        assert.match(copy, /The register locks/, `the confirm did not say it locks: ${copy}`);

        let pushed = null;
        await readToast(page, /Register locked/, async () => {
          const [res] = await Promise.all([
            page.waitForResponse(
              (r) => new URL(r.url()).pathname.endsWith("/attendance/push"),
              { timeout: WAIT_MS },
            ),
            confirm.getByTestId("push-confirm-submit").click(),
          ]);
          pushed = await res.json();
        });
        assert.equal(pushed?.ok, true, `the push failed: ${JSON.stringify(pushed)}`);
        assert.equal(pushed.alreadyPushed, false, "the first press reported a second one");
        assert.equal(
          pushed.mirrored,
          state.members.length,
          "the push did not rebuild every member's attendance record",
        );
        if (mailFlows) {
          assert.equal(
            pushed.sent,
            state.members.length,
            `the push did not email the group: ${JSON.stringify(pushed)}`,
          );
        } else {
          assert.equal(
            pushed.sent,
            0,
            "mail is suppressed for this target, so the push must have sent nothing",
          );
        }

        // The column is now a pushed column: it says so, and the two controls
        // that belong to a draft are gone. The cells stay editable for THIS
        // caller because they are an admin (`canEditPushed`), which is the lane
        // the correction step below travels.
        const header = headerOf(page, PUSH_WEEK - 1);
        await header.getByText("Pushed").waitFor({ timeout: WAIT_MS });
        assert.equal(
          await header.getByTestId("attendance-push").count(),
          0,
          "the push button survived the push",
        );
        assert.equal(
          await header.getByTestId("attendance-bulk").count(),
          0,
          "the bulk mark button survived the push",
        );
        await header.getByTestId("attendance-resend").waitFor({ timeout: WAIT_MS });

        // THE LOCK ITSELF, which the two hidden buttons above are only a
        // picture of. The draft lane refuses a pushed register for EVERYONE,
        // this admin included: the admin's door is PATCH, and that is the
        // whole reason the PATCH lane exists. Asserted here because the UI
        // cannot show it: an admin's cells stay tappable, so no click in this
        // browser ever reaches the refusal.
        //
        // Issued from the page's own context, so it carries the same session
        // cookie the grid's own writes do rather than a second identity.
        // `occurrence: 1` because this group meets once a week; a session that
        // did not exist would come back 404 rather than 409, so a fixture that
        // drifted fails here loudly instead of passing on the wrong reason.
        const refused = await page.evaluate(
          async ([groupId, weekNumber, uid]) => {
            const res = await fetch(
              `/api/courses/groups/${encodeURIComponent(groupId)}/attendance`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  weekNumber,
                  occurrence: 1,
                  marks: [{ uid, status: "absent" }],
                }),
              },
            );
            return { status: res.status, body: await res.json().catch(() => null) };
          },
          [state.groupId, PUSH_WEEK, state.members[0].uid],
        );
        assert.equal(
          refused.status,
          409,
          `the draft lane accepted a write to a pushed register: ${JSON.stringify(refused)}`,
        );
        assert.match(
          refused.body?.error ?? "",
          /This register has been pushed, so it's locked/,
          `the refusal did not say why: ${JSON.stringify(refused.body)}`,
        );
      });

      await step("a second press answers that the register was already pushed", async () => {
        await headerOf(stale, PUSH_WEEK - 1).getByTestId("attendance-push").click();
        const confirm = stale.getByTestId("push-confirm");
        await confirm.waitFor({ timeout: WAIT_MS });
        let again = null;
        await readToast(stale, /already pushed, so nothing was sent again/, async () => {
          const [res] = await Promise.all([
            stale.waitForResponse(
              (r) => new URL(r.url()).pathname.endsWith("/attendance/push"),
              { timeout: WAIT_MS },
            ),
            confirm.getByTestId("push-confirm-submit").click(),
          ]);
          again = await res.json();
        });
        // A 200, not an error: pressing twice is a thing people do, and nothing
        // happens the second time.
        assert.equal(again?.ok, true, `the second press failed: ${JSON.stringify(again)}`);
        assert.equal(again.alreadyPushed, true, "the second press was treated as a first");
        assert.equal(again.sent, 0, "the second press sent mail");
        assert.equal(again.mirrored, 0, "the second press rewrote the records again");
      });

      await step("an admin edit of a pushed mark changes it and logs an audit row", async () => {
        // The cell reads Present; one tap on a PUSHED register takes the
        // admin's PATCH lane rather than the facilitator's POST, which is the
        // whole shape of the boundary: the draft lane is closed and this one
        // writes an audit row for every mark it moves.
        const cell = cellOf(page, 0, PUSH_WEEK - 1);
        assert.equal(await statusOf(cell), "Present", "the pushed mark is not what it was");
        const edited = await tap(page, cell, { method: "PATCH" });
        assert.equal(edited.marked, 1, "the correction moved something other than one mark");
        assert.ok(edited.logged >= 1, "the correction logged no audit row");

        await reload(page);
        assert.equal(
          await statusOf(cellOf(page, 0, PUSH_WEEK - 1)),
          "Late",
          "the correction did not stick",
        );

        // The row itself, read from the collection the admin surfaces read.
        const audit = await fixtureQuery("courseAudit")
          .where("runId", "==", state.runId)
          .where("kind", "==", "attendance-edit")
          .get();
        assert.ok(
          audit.size >= 1,
          "no attendance-edit row was written, so the correction is unattributable",
        );
        const detail = audit.docs.map((d) => d.data().detail ?? "").join(" | ");
        assert.match(
          detail,
          /Present to Late/,
          `the audit row does not say what changed: ${detail}`,
        );
      });

      await step("the admin resend reports what it did", async () => {
        await headerOf(page, PUSH_WEEK - 1).getByTestId("attendance-resend").click();
        const confirmResend = page.getByTestId("attendance-resend-confirm");
        await confirmResend.waitFor({ timeout: WAIT_MS });
        // The promise the dialog makes about blast radius: this group and
        // nobody else. It is the whole reason the per-group force exists
        // beside the run-wide catch-up.
        const dialogCopy = (
          await page.getByRole("dialog", { name: "Re-send this group's reminder" }).innerText()
        ).replace(/\s+/g, " ");
        assert.match(
          dialogCopy,
          new RegExp(`everyone in ${state.groupName} gets the message again`),
          `the resend dialog did not name who is emailed: ${dialogCopy}`,
        );
        assert.match(
          dialogCopy,
          /nobody outside the group is emailed/,
          `the resend dialog did not bound who is emailed: ${dialogCopy}`,
        );
        let resent = null;
        // Two honest outcomes, and which one is right is a fact about the
        // TARGET rather than about the button: with mail caught the group is
        // emailed again, and with every fixture address suppressed the route
        // says plainly that nobody was.
        const expected = mailFlows
          ? /emailed again about the next session/
          : /Nobody in this group is set up to receive email/;
        await readToast(page, expected, async () => {
          const [res] = await Promise.all([
            page.waitForResponse(
              (r) => new URL(r.url()).pathname.endsWith("/attendance/push"),
              { timeout: WAIT_MS },
            ),
            confirmResend.click(),
          ]);
          resent = await res.json();
        });
        assert.equal(resent?.ok, true, `the resend failed: ${JSON.stringify(resent)}`);
        if (mailFlows) {
          assert.equal(resent.sent, state.members.length, "the resend did not reach the group");
          assert.equal(
            resent.forced,
            true,
            "the resend did not record itself as a force over the claimed marker",
          );
        } else {
          assert.equal(resent.sent, 0, "a suppressed run sent mail");
        }
      });

      await step("the push mailed the group and closed nothing it should not have", async () => {
        // THE SEND LOG, not an inbox: it is what the deliverability tab reads
        // and the only record that survives the message.
        for (const member of state.members) {
          const sends = await fixtureQuery("emailSends")
            .where("to", "==", member.email)
            .get();
          if (mailFlows) {
            // One for the push, one for the resend.
            assert.equal(
              sends.size,
              2,
              `expected the push and the resend to log one row each for a member, got ${sends.size}`,
            );
            for (const doc of sends.docs) {
              assert.equal(doc.data().kind, "course-nudge", "a send logged the wrong kind");
              assert.equal(
                doc.data().referenceId,
                state.runId,
                "a send was logged against another run",
              );
            }
          } else {
            assert.equal(
              sends.size,
              0,
              "a suppressed address was mailed anyway, which is the one thing suppression is for",
            );
          }
        }

        // The reminder marker: claimed exactly once, whatever the resend did to
        // it. Absent when nothing was sent, because the route deliberately does
        // not claim a marker for a send it declined to make.
        const markers = await fixtureQuery("courseNudges")
          .where("groupId", "==", state.groupId)
          .get();
        assert.equal(
          markers.size,
          mailFlows ? 1 : 0,
          `the group's reminder marker count is wrong: ${markers.size}`,
        );

        // The mirrors: every member's rollup was rebuilt from the pushed
        // register, which is the fact a reviewer reads months later.
        for (const member of state.members) {
          const snap = await fixtureDoc(
            "courseEnrolments",
            enrolmentId(state.runId, member.uid),
          ).get();
          assert.equal(
            snap.data()?.attendance?.lastPushedSessionKey,
            weekDocId(PUSH_WEEK),
            "a member's attendance record was not rebuilt by the push",
          );
        }

        // THE FOLLOW-UP CARD. The push archives the unmarked-register task the
        // scheduler raises when a register goes unmarked past its grace, and
        // there is none here: no tick runs during an end-to-end run, so the
        // push had nothing to close. Asserted rather than assumed, because a
        // card appearing here would mean this run created committee work that
        // teardown would have to be told about.
        const followUps = await fixtureQuery("tasks")
          .where("source", "==", "course-register")
          .where("sourceRef.groupId", "==", state.groupId)
          .get();
        assert.equal(
          followUps.size,
          0,
          "a register follow-up card exists for this group, which nothing in this run creates",
        );
      });
    } finally {
      if (stale) await stale.close().catch(() => {});
      await context.close();
      await browser.close();
      recorder.writeMarker();
    }
  },
);
