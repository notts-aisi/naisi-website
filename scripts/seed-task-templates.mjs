#!/usr/bin/env node
/**
 * Seeds the initial `taskTemplates/` collection from the hardcoded subtask
 * checklists that used to live in src/lib/firestore/tasks.ts. Admins can edit
 * these freely from the admin UI after seeding.
 *
 * Each seeded template gets a deterministic id (`seed_<kind>`) so re-running is
 * idempotent — existing seeds are left alone; only missing ones are created.
 *
 * Credentials: same pattern as migrate-assignee-to-completer.mjs.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-task-templates.mjs --project dev
 */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const SEEDS = [
  {
    id: "seed_social",
    kind: "social",
    name: "Social",
    description: "Standard checklist for running a committee social.",
    subtasks: [
      "Pick date + time",
      "Book venue / pick location",
      "Create poster or graphic",
      "Announce on Instagram",
      "Announce in Slack / Discord",
      "Confirm rough numbers",
      "Run the social",
      "Post short debrief / photo",
    ],
  },
  {
    id: "seed_event",
    kind: "event",
    name: "Event",
    description: "End-to-end checklist for running a NAISI event.",
    subtasks: [
      "Confirm date + speaker(s)",
      "Book venue",
      "Create poster + any materials",
      "Open sign-ups / RSVP (when available)",
      "Announce on Instagram",
      "Announce in Slack / Discord",
      "Send reminder day-before",
      "Run event",
      "Share recording / resources afterwards",
    ],
  },
  {
    id: "seed_instagram_post",
    kind: "instagram-post",
    name: "Instagram post",
    description: "Draft → review → publish flow for a grid post.",
    subtasks: [
      { title: "Draft caption", roleHint: "completer" },
      { title: "Create visual / carousel", roleHint: "completer" },
      { title: "Copy approved", roleHint: "reviewer", blockedByIdx: [0, 1] },
      { title: "Visual approved", roleHint: "reviewer", blockedByIdx: [0, 1] },
      { title: "Scheduled in planner", blockedByIdx: [2, 3] },
      { title: "Posted", blockedByIdx: [4] },
      { title: "Engagement check next day", blockedByIdx: [5] },
    ],
  },
  {
    id: "seed_instagram_story",
    kind: "instagram-story",
    name: "Instagram story",
    description: "Quick checklist for a story post.",
    subtasks: [
      "Create visual",
      "Draft caption / stickers",
      "Post story",
      "Check replies + engagement",
    ],
  },
];

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

function makeSubtasks(list) {
  // Generate stable ids first so blockedByIdx can resolve to real ids.
  const withIds = list.map((raw, i) => {
    const base = typeof raw === "string" ? { title: raw } : raw;
    return {
      id: `st_${String(i).padStart(2, "0")}`,
      title: base.title,
      roleHint: base.roleHint === "completer" || base.roleHint === "reviewer"
        ? base.roleHint
        : null,
      blockedByIdx: Array.isArray(base.blockedByIdx) ? base.blockedByIdx : [],
    };
  });
  return withIds.map((s) => ({
    id: s.id,
    title: s.title,
    roleHint: s.roleHint,
    blockedBy: s.blockedByIdx.map((i) => withIds[i]?.id).filter(Boolean),
  }));
}

async function run() {
  const { project, dryRun } = parseArgs();
  init();
  const db = getFirestore();
  const label = project ?? process.env.FIREBASE_ADMIN_PROJECT_ID;
  console.log(`[seed-templates] target project: ${label}${dryRun ? " (dry run)" : ""}`);

  let created = 0;
  let skipped = 0;

  for (const seed of SEEDS) {
    const ref = db.collection("taskTemplates").doc(seed.id);
    const existing = await ref.get();
    if (existing.exists) {
      console.log(`[seed-templates] ${seed.id}: skip (exists)`);
      skipped++;
      continue;
    }

    const payload = {
      name: seed.name,
      description: seed.description,
      kind: seed.kind,
      subtasks: makeSubtasks(seed.subtasks),
      defaultCompleterCount: null,
      createdByUid: "system-seed",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    console.log(`[seed-templates] ${seed.id}: create (${payload.subtasks.length} subtasks)`);
    if (!dryRun) await ref.set(payload);
    created++;
  }

  console.log(
    `[seed-templates] done. created=${created} skipped=${skipped}${dryRun ? " (dry run)" : ""}`,
  );
}

run().catch((err) => {
  console.error("[seed-templates] failed:", err);
  process.exit(1);
});
