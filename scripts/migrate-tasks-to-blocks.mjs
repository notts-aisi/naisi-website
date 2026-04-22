#!/usr/bin/env node
/**
 * Phase 3 migration: backfill every task doc with the block-system fields.
 *
 * - Adds `blocks: []` and `blockConsents: {}` on any task missing them.
 * - Extends each subtask with the new fields introduced in Phase 3:
 *     `blockId: null` (ungrouped by default — tasks stay in pre-Phase-3 shape
 *       visually; users opt into blocks by creating one on demand)
 *     `sealState: "open"`
 *     `sealedAt: null`
 *     `roleHint: null` (restored — was deleted in Phase 2's review-matrix PR
 *       but Phase 3 uses it for auto-spawned review subtasks in PR 2)
 *     `rejectedByReviewerUids: []` (the fourth review-matrix state,
 *       wired into the popover in PR 2; lands now so the data model only
 *       migrates once)
 *
 * Idempotent — safe to re-run. Skips any doc already carrying every new field.
 *
 * Usage (matches the Phase 2 script pattern):
 *   node --env-file=.env.local scripts/migrate-tasks-to-blocks.mjs --project dev
 *   node --env-file=.env.prod  scripts/migrate-tasks-to-blocks.mjs --project default
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { project: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") out.project = args[i + 1] ?? null;
    if (args[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

function init() {
  if (getApps().length) return;
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    console.error(
      "Missing credentials. Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY (e.g. via --env-file=.env.local).",
    );
    process.exit(1);
  }
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
}

function upgradeSubtask(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const needsBlockId = s.blockId === undefined;
  const needsSealState = s.sealState === undefined;
  const needsSealedAt = s.sealedAt === undefined;
  const needsRoleHint = s.roleHint === undefined;
  const needsRejected = !Array.isArray(s.rejectedByReviewerUids);
  const upgraded = needsBlockId || needsSealState || needsSealedAt || needsRoleHint || needsRejected;
  if (!upgraded) return { upgraded: false, value: s };
  return {
    upgraded: true,
    value: {
      ...s,
      blockId: needsBlockId ? null : s.blockId,
      sealState: needsSealState ? "open" : s.sealState,
      sealedAt: needsSealedAt ? null : s.sealedAt,
      roleHint:
        needsRoleHint
          ? null
          : s.roleHint === "completer" || s.roleHint === "reviewer"
            ? s.roleHint
            : null,
      rejectedByReviewerUids: needsRejected ? [] : s.rejectedByReviewerUids,
    },
  };
}

async function run() {
  const { project, dryRun } = parseArgs();
  init();
  const db = getFirestore();
  const label = project ?? process.env.FIREBASE_ADMIN_PROJECT_ID;
  console.log(`[migrate-blocks] target project: ${label}${dryRun ? " (dry run)" : ""}`);

  const snap = await db.collection("tasks").get();
  console.log(`[migrate-blocks] found ${snap.size} tasks`);

  let migrated = 0;
  let skipped = 0;
  let subtasksUpgraded = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    const needsBlocks = !Array.isArray(data.blocks);
    const needsBlockConsents =
      !data.blockConsents || typeof data.blockConsents !== "object";

    const rawSubtasks = Array.isArray(data.subtasks) ? data.subtasks : [];
    const upgradedSubtasks = rawSubtasks.map(upgradeSubtask);
    const someSubtaskChanged = upgradedSubtasks.some((u) => u.upgraded);

    if (!needsBlocks && !needsBlockConsents && !someSubtaskChanged) {
      skipped++;
      continue;
    }

    const patch = {};
    if (needsBlocks) patch.blocks = [];
    if (needsBlockConsents) patch.blockConsents = {};
    if (someSubtaskChanged) {
      patch.subtasks = upgradedSubtasks.map((u) => u.value);
      subtasksUpgraded += upgradedSubtasks.filter((u) => u.upgraded).length;
    }

    console.log(
      `[migrate-blocks] ${doc.id}: ${Object.keys(patch).join(", ")}`,
    );
    if (!dryRun) await doc.ref.update(patch);
    migrated++;
  }

  console.log(
    `[migrate-blocks] done. migrated=${migrated} skipped=${skipped} subtasksUpgraded=${subtasksUpgraded}${dryRun ? " (dry run — no writes)" : ""}`,
  );
}

run().catch((err) => {
  console.error("[migrate-blocks] failed:", err);
  process.exit(1);
});
