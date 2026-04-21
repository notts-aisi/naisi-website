#!/usr/bin/env node
/**
 * One-shot migration: rename `assigneeUids` → `completerUids` on every task doc,
 * backfill `reviewerUids: []` + `sourceTemplateId: null`, and upgrade subtasks
 * to the new shape (`assigneeUids`, `reviewerUids`, `blockedBy`, `roleHint`).
 *
 * Idempotent — safe to re-run. Skips any doc already shaped per the new schema.
 *
 * Credentials: reads `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
 * `FIREBASE_ADMIN_PRIVATE_KEY` from the environment (matching the pattern in
 * src/lib/firebase/admin.ts). For dev vs prod, export the appropriate values
 * before running (or use `node --env-file=.env.dev scripts/...`).
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-assignee-to-completer.mjs --project dev
 *   node --env-file=.env.prod  scripts/migrate-assignee-to-completer.mjs --project default
 *
 * The --project flag is informational only; credentials determine the target.
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
  const hasArrays =
    Array.isArray(s.assigneeUids) && Array.isArray(s.reviewerUids) && Array.isArray(s.blockedBy);
  if (hasArrays) return { upgraded: false, value: s };
  return {
    upgraded: true,
    value: {
      ...s,
      assigneeUids: Array.isArray(s.assigneeUids) ? s.assigneeUids : [],
      reviewerUids: Array.isArray(s.reviewerUids) ? s.reviewerUids : [],
      blockedBy: Array.isArray(s.blockedBy) ? s.blockedBy : [],
      roleHint:
        s.roleHint === "completer" || s.roleHint === "reviewer" ? s.roleHint : null,
    },
  };
}

async function run() {
  const { project, dryRun } = parseArgs();
  init();
  const db = getFirestore();
  const label = project ?? process.env.FIREBASE_ADMIN_PROJECT_ID;
  console.log(`[migrate] target project: ${label}${dryRun ? " (dry run)" : ""}`);

  const snap = await db.collection("tasks").get();
  console.log(`[migrate] found ${snap.size} tasks`);

  let migrated = 0;
  let skipped = 0;
  let subtasksUpgraded = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const hasOld = Array.isArray(data.assigneeUids);
    const hasNew = Array.isArray(data.completerUids);

    const rawSubtasks = Array.isArray(data.subtasks) ? data.subtasks : [];
    const upgradedSubtasks = rawSubtasks.map(upgradeSubtask);
    const someSubtaskChanged = upgradedSubtasks.some((u) => u.upgraded);
    const needsReviewerUids = !Array.isArray(data.reviewerUids);
    const needsSourceTemplateId = data.sourceTemplateId === undefined;

    if (hasNew && !hasOld && !someSubtaskChanged && !needsReviewerUids && !needsSourceTemplateId) {
      skipped++;
      continue;
    }

    const patch = {};
    if (hasOld) {
      patch.completerUids = hasNew ? data.completerUids : data.assigneeUids;
      patch.assigneeUids = FieldValue.delete();
    } else if (!hasNew) {
      patch.completerUids = [];
    }
    if (needsReviewerUids) patch.reviewerUids = [];
    if (needsSourceTemplateId) patch.sourceTemplateId = null;
    if (someSubtaskChanged) {
      patch.subtasks = upgradedSubtasks.map((u) => u.value);
      subtasksUpgraded += upgradedSubtasks.filter((u) => u.upgraded).length;
    }

    console.log(
      `[migrate] ${doc.id}: ${Object.keys(patch).filter((k) => k !== "assigneeUids").join(", ") || "(only drop assigneeUids)"}`,
    );
    if (!dryRun) await doc.ref.update(patch);
    migrated++;
  }

  console.log(
    `[migrate] done. migrated=${migrated} skipped=${skipped} subtasksUpgraded=${subtasksUpgraded}${dryRun ? " (dry run — no writes)" : ""}`,
  );
}

run().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
