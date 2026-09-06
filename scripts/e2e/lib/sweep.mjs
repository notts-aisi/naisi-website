/**
 * Sweeps fixture rows and harness accounts that a run left behind WITHOUT a
 * ledger: a CI runner cancelled between seed and teardown, a laptop that lost
 * power. Keyed by run id, never by age or by namespace alone.
 *
 * Every fixture row embeds its run id somewhere the scan can see: the document
 * id (`{slug}__{runId}`, core.mjs), a derived field (`runId`, a `cohort:` channel,
 * a `subscriptionId`, an `eventId`, `sourceRef.cohortId`) or a harness address
 * (`e2e-f{runId}{n}@e2e.invalid`). So "every document in a fixture collection
 * whose id or data mentions one of the ids" is exact, and it needs no per-spec
 * knowledge, which is the point: the spec's own teardown needs the ledger, and
 * the ledger is what a cancelled runner does not have.
 *
 * Goes through the harness's own doors only: `fixtureQuery` / `fixtureDoc` /
 * `fixtureSubcollection` (the collection chokepoint) and the guarded harness
 * account helpers, so it can touch nothing a fixture could not. `config` is
 * skipped: its membership doc is shared and the fixtures only ever edit it.
 *
 * Found on 6 September 2026, when a cancelled CI run left seven fixtures on
 * dev: five courses, an event, two rounds, thirteen accounts. The runner's
 * `--sweep` flag is this function.
 */
import {
  FIXTURE_COLLECTIONS,
  FIXTURE_SUBCOLLECTIONS,
  assertFixtureTarget,
  fixtureDoc,
  fixtureQuery,
  fixtureSubcollection,
} from "../../e2e-fixtures/core.mjs";
import { adminAuth, deleteHarnessUser, deleteHarnessUserDoc, isHarnessAccount } from "./admin.mjs";

const RUN_ID = /^[a-z0-9]{8,32}$/;

/**
 * @param {string[]} runIds  The run ids to sweep (base36, as the runner mints them).
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [options]
 * @returns {Promise<{ rows: number, accounts: number, deleted: boolean }>}
 */
export async function sweepRunIds(runIds, { dryRun = false, log = console.log } = {}) {
  const ids = [...new Set(runIds.map((id) => String(id).trim()).filter(Boolean))];
  for (const id of ids) {
    if (!RUN_ID.test(id)) {
      throw new Error(`REFUSING to sweep ${JSON.stringify(id)}: not a run id (base36, 8 to 32 characters).`);
    }
  }
  if (ids.length === 0) throw new Error("REFUSING to sweep nothing: name at least one run id.");
  const target = assertFixtureTarget();
  const mentions = (value) => {
    const text = JSON.stringify(value) ?? "";
    return ids.some((id) => text.includes(id));
  };
  log(`Sweeping ${ids.length} run id(s) on ${target.projectId}${dryRun ? " (dry run)" : ""}.`);

  let rows = 0;
  for (const collection of FIXTURE_COLLECTIONS) {
    if (collection === "config") continue;
    const snap = await fixtureQuery(collection).get();
    const hits = snap.docs.filter((doc) => mentions(doc.id) || mentions(doc.data()));
    if (hits.length === 0) continue;
    log(`${collection}: ${hits.length} of ${snap.size}`);
    rows += hits.length;
    if (dryRun) continue;
    for (const doc of hits) {
      for (const sub of FIXTURE_SUBCOLLECTIONS) {
        const subSnap = await fixtureSubcollection(collection, doc.id, sub).get();
        for (const child of subSnap.docs) await child.ref.delete();
        if (subSnap.size > 0) log(`  ${collection}/${doc.id}/${sub}: ${subSnap.size}`);
      }
      await fixtureDoc(collection, doc.id).delete();
    }
  }

  const auth = adminAuth();
  const accounts = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (isHarnessAccount(user.email) && mentions(user.email)) accounts.push(user);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  log(`harness accounts: ${accounts.length}`);
  if (!dryRun) {
    for (const user of accounts) {
      await deleteHarnessUserDoc(user.uid);
      await deleteHarnessUser(user.uid);
    }
  }
  log(`${dryRun ? "would remove" : "removed"} ${rows} row(s) and ${accounts.length} account(s).`);
  return { rows, accounts: accounts.length, deleted: !dryRun };
}
