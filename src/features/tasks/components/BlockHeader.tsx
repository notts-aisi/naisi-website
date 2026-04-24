"use client";

import { useState } from "react";
import {
  TASK_FIELD_LIMITS,
  getBlockConsensusState,
  getBlockEffectiveReviewerUids,
  getBlockPhase,
  type BlockGatingMode,
  type TaskBlock,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import { BLOCK_PHASE_PALETTE } from "./SubtaskList";
import {
  deleteBlock,
  ensureBlockReviewSubtasks,
  finalizeBlockSetup,
  forceSealBlock,
  renameBlock,
  setBlockDueDate,
  setBlockGatingMode,
  toggleBlockConsent,
  unsealBlock,
} from "../taskMutations";

function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const GATING_LABELS: Record<BlockGatingMode, string> = {
  previous: "Gated by previous block",
  "all-previous": "Gated by all previous blocks",
  none: "Not gated",
};

type Props = {
  task: TaskDoc;
  block: TaskBlock;
  viewerUid: string;
  isAdmin: boolean;
  isCreator: boolean;
  /** Committee members (including admin/creator) who run the block on a
   *  committee-visibility task can rename + delete a block. Matches the
   *  `canEditAll` gate used elsewhere. */
  canEditStructure: boolean;
};

export default function BlockHeader({
  task,
  block,
  viewerUid,
  isAdmin,
  isCreator,
  canEditStructure,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(block.name);
  const [busy, setBusy] = useState(false);

  const consensus = getBlockConsensusState(task, block.id);
  const isCompleter = task.completerUids.includes(viewerUid);
  const hasConsented = consensus.consenting.includes(viewerUid);
  const isSealed = block.sealState === "sealed";
  const isSetup = block.sealState === "setup";
  const isTaskReviewer = task.reviewerUids.includes(viewerUid);
  // Task-setter phase: only admin + task-level reviewers + the task creator
  // can finalize the block's subtask structure and open it for allocation.
  // Committee-at-large is deliberately excluded. Creator is included so
  // reviewer-less tasks (common on committee generics + personal tasks)
  // aren't stuck in setup forever waiting for a reviewer who doesn't
  // exist — the person who set it up can move it forward.
  const canFinalizeSetup = isAdmin || isTaskReviewer || isCreator;
  const requiredCount = consensus.required.length;
  const consentCount = consensus.consenting.length;
  // Stage 1.5a: lock-in is an ALLOCATION gate, not a submission gate.
  // Completers can lock in as soon as they're happy with who's doing what;
  // work-done is gated separately by the "Send block to reviewers" button
  // at the bottom of the completion block.

  // Stage 1.5a gap-fix: the LAST lock-in (the consent that would seal the
  // block) is gated on every non-reviewer subtask having ≥1 assignee.
  // Earlier consents pass unchecked — they don't yet commit the allocation.
  const wouldSealOnMyConsent =
    !hasConsented &&
    isCompleter &&
    requiredCount > 0 &&
    requiredCount === consentCount + 1;
  const unassignedInBlock = wouldSealOnMyConsent
    ? task.subtasks.filter(
        (s) =>
          s.blockId === block.id &&
          s.roleHint !== "reviewer" &&
          s.assigneeUids.length === 0,
      )
    : [];
  const finalLockInBlocked = unassignedInBlock.length > 0;
  const finalLockInTooltip = finalLockInBlocked
    ? `Can't seal yet — unassigned subtasks: ${unassignedInBlock
        .slice(0, 3)
        .map((s) => `"${s.title}"`)
        .join(", ")}${unassignedInBlock.length > 3 ? ` (+${unassignedInBlock.length - 3} more)` : ""}`
    : null;
  // Missing-reviewer detection for the admin catch-up button. Compares
  // every effective reviewer for the block against existing reviewer-hint
  // rows in that block. Non-zero when a reviewer got added to the task
  // *after* the block was sent to reviewers. Stage 1.5a (2026-04-23):
  // gated on having at least one existing signoff row so the button
  // doesn't show pre-Notify (where zero rows is the intended state).
  const effectiveReviewers = getBlockEffectiveReviewerUids(task, block.id);
  const existingReviewerUids = new Set(
    task.subtasks
      .filter((s) => s.blockId === block.id && s.roleHint === "reviewer")
      .flatMap((s) => s.reviewerUids),
  );
  const hasSpawnedRows = existingReviewerUids.size > 0;
  const missingReviewerCount = hasSpawnedRows
    ? effectiveReviewers.filter((u) => !existingReviewerUids.has(u)).length
    : 0;

  async function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === block.name) {
      setNameDraft(block.name);
      setEditingName(false);
      return;
    }
    try {
      await renameBlock(task, block.id, trimmed);
    } catch (err) {
      console.error(err);
      setNameDraft(block.name);
    }
    setEditingName(false);
  }

  async function handleLockInToggle() {
    if (busy || isSealed) return;
    setBusy(true);
    try {
      await toggleBlockConsent(task, block.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleForceSeal() {
    if (busy) return;
    const ok = window.confirm(
      `Force-seal "${block.name}" without waiting for everyone to lock in? This is an admin escape hatch — logged to the activity feed.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await forceSealBlock(task, block.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnseal() {
    if (busy) return;
    const ok = window.confirm(
      `Re-open "${block.name}"? The lock-in tally resets to 0 and completers can edit allocation again.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await unsealBlock(task, block.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleSpawnMissing() {
    if (busy) return;
    setBusy(true);
    try {
      const added = await ensureBlockReviewSubtasks(task, block.id);
      if (added === 0) {
        window.alert("No missing reviewer rows — every effective reviewer already has one.");
      }
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleBlockDueChange(value: string) {
    const next = value ? new Date(value) : null;
    setBusy(true);
    try {
      await setBlockDueDate(task, block.id, next);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Couldn't set block due date");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalizeSetup() {
    if (busy) return;
    const completionCount = task.subtasks.filter(
      (s) => s.blockId === block.id && s.roleHint !== "reviewer",
    ).length;
    if (completionCount === 0) {
      const ok = window.confirm(
        `"${block.name}" has no subtasks yet. Finalize anyway? You can still add subtasks post-finalize as admin, but normal users won't be able to.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      await finalizeBlockSetup(task, block.id);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Finalize failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (busy) return;
    const ok = window.confirm(
      `Delete block "${block.name}"? Subtasks inside it will be un-grouped, not deleted.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await deleteBlock(task, block.id);
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  const phase = getBlockPhase(task, block);
  const phasePalette = BLOCK_PHASE_PALETTE[phase];
  const showGating = block.order > 0;
  // Task-level reviewers can also manage gating — they steer the review
  // flow. Admin bypass implicit.
  const canEditGating = isAdmin || task.reviewerUids.includes(viewerUid);

  // Block-level due-date cascade (Phase 3): infer the "common" date from
  // non-reviewer subtasks in the block. If every subtask shares the same
  // date, show it; if they differ, show "Mixed" and still let the control
  // overwrite them all. Empty block → null.
  const completionSubtasksInBlock = task.subtasks.filter(
    (s) => s.blockId === block.id && s.roleHint !== "reviewer",
  );
  const dueTimestamps = completionSubtasksInBlock.map((s) =>
    s.dueDate ? s.dueDate.getTime() : null,
  );
  const commonDue: Date | null =
    dueTimestamps.length > 0 && dueTimestamps.every((t) => t === dueTimestamps[0])
      ? dueTimestamps[0] !== null
        ? new Date(dueTimestamps[0])
        : null
      : null;
  const dueIsMixed =
    dueTimestamps.length > 0 && !dueTimestamps.every((t) => t === dueTimestamps[0]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "0.65rem 0.85rem",
        background: phasePalette.bg,
        border: `1px solid ${phasePalette.border}`,
        borderRadius: "var(--radius-md)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
        {editingName && canEditStructure ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") {
                setNameDraft(block.name);
                setEditingName(false);
              }
            }}
            maxLength={TASK_FIELD_LIMITS.blockName}
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              padding: "0.25rem 0.5rem",
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm, 4px)",
              color: "var(--color-text)",
            }}
          />
        ) : (
          <span
            onClick={() => canEditStructure && setEditingName(true)}
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              color: "var(--color-text)",
              cursor: canEditStructure ? "text" : "default",
            }}
          >
            {block.name}
          </span>
        )}

        <span
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "2px 8px",
            borderRadius: "999px",
            background: phasePalette.border,
            color: "white",
            border: "none",
            fontWeight: 700,
          }}
          title={
            phase === "setup"
              ? "Setup — reviewers defining what subtasks exist. Finalize to start allocation."
              : phase === "allocating"
                ? "Allocating — completers deciding who does what."
                : phase === "in-progress"
                  ? block.forceSealedByUid
                    ? "In progress — work under way. (admin force-sealed allocation)"
                    : "In progress — allocation locked, work under way."
                  : phase === "reviewing"
                    ? "Under review — reviewers working through the block."
                    : "Complete — every reviewer has signed off."
          }
        >
          {phasePalette.label}
        </span>

        {!isSealed && !isSetup && requiredCount > 0 && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--color-text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}
            title="Completers who've clicked Lock-in"
          >
            {consentCount} of {requiredCount} locked in
          </span>
        )}

        {isSealed && block.sealedAt && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--color-text-muted)",
            }}
          >
            Sealed {block.sealedAt.toLocaleDateString()}
            {block.forceSealedByUid ? " (admin force)" : ""}
          </span>
        )}

        {showGating && canEditGating && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "0.35rem 0.75rem",
              background:
                block.gatingMode === "none"
                  ? "var(--color-bg-elevated)"
                  : "var(--color-accent-soft)",
              border: `1px solid ${
                block.gatingMode === "none"
                  ? "var(--color-border)"
                  : "var(--color-accent)"
              }`,
              borderRadius: "999px",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              color:
                block.gatingMode === "none"
                  ? "var(--color-text-muted)"
                  : "var(--color-accent)",
              cursor: "pointer",
            }}
            title="Controls what must be complete before this block's work can start."
          >
            <span aria-hidden="true" style={{ fontSize: "14px", lineHeight: 1 }}>
              {block.gatingMode === "none" ? "🔓" : "🔗"}
            </span>
            <select
              value={block.gatingMode}
              onChange={(e) =>
                setBlockGatingMode(
                  task,
                  block.id,
                  e.target.value as BlockGatingMode,
                ).catch(console.error)
              }
              aria-label="Upstream gating for this block"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                fontSize: "inherit",
                fontWeight: "inherit",
                fontFamily: "inherit",
                cursor: "pointer",
                outline: "none",
                padding: 0,
                paddingRight: "0.2rem",
              }}
            >
              <option value="previous">{GATING_LABELS.previous}</option>
              <option value="all-previous">{GATING_LABELS["all-previous"]}</option>
              <option value="none">{GATING_LABELS.none}</option>
            </select>
          </label>
        )}
        {showGating && !canEditGating && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
              padding: "0.25rem 0.6rem",
              borderRadius: "999px",
              background:
                block.gatingMode === "none"
                  ? "var(--color-bg-elevated)"
                  : "var(--color-accent-soft)",
              border: `1px solid ${
                block.gatingMode === "none"
                  ? "var(--color-border)"
                  : "var(--color-accent)"
              }`,
              color:
                block.gatingMode === "none"
                  ? "var(--color-text-muted)"
                  : "var(--color-accent)",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
            title={GATING_LABELS[block.gatingMode]}
          >
            <span aria-hidden="true">{block.gatingMode === "none" ? "🔓" : "🔗"}</span>
            {block.gatingMode === "none" ? "Ungated" : "Gated"}
          </span>
        )}

        {canEditStructure && completionSubtasksInBlock.length > 0 && (
          <label
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "0.35rem 0.75rem",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: "999px",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              color: "var(--color-text-muted)",
              cursor: "pointer",
            }}
            title="Set due date for every subtask in this block. Overwrites individual dates."
          >
            <span aria-hidden="true" style={{ fontSize: "14px", lineHeight: 1 }}>
              📅
            </span>
            <span>
              {dueIsMixed
                ? "Mixed dates"
                : commonDue
                  ? commonDue.toLocaleDateString()
                  : "Set all due"}
            </span>
            <input
              type="date"
              value={commonDue ? toDateInputValue(commonDue) : ""}
              onChange={(e) => handleBlockDueChange(e.target.value).catch(console.error)}
              disabled={busy}
              aria-label="Set due date for every subtask in this block"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                opacity: 0,
                cursor: "pointer",
              }}
            />
          </label>
        )}

        <div style={{ marginLeft: "auto", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          {isSetup && canFinalizeSetup && (
            <button
              type="button"
              onClick={handleFinalizeSetup}
              disabled={busy}
              style={{
                padding: "0.3rem 0.75rem",
                background: "rgba(124, 58, 237, 0.12)",
                color: "#7c3aed",
                border: "none",
                borderRadius: "var(--radius-sm, 4px)",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
              }}
              title={
                isAdmin
                  ? "Finalize setup: lock which subtasks exist and open this block for allocation."
                  : "Finalize setup: confirm subtask structure and open this block for completers to allocate."
              }
            >
              Finalize setup
            </button>
          )}
          {!isSealed && !isSetup && isCompleter && (
            <button
              type="button"
              onClick={handleLockInToggle}
              disabled={busy || finalLockInBlocked}
              style={{
                padding: "0.3rem 0.75rem",
                background: hasConsented
                  ? "var(--color-success-soft, rgba(22, 163, 74, 0.12))"
                  : "var(--color-accent-soft)",
                color: hasConsented
                  ? "var(--color-success, #16a34a)"
                  : "var(--color-accent)",
                border: "none",
                borderRadius: "var(--radius-sm, 4px)",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                cursor: busy || finalLockInBlocked ? "not-allowed" : "pointer",
                opacity: finalLockInBlocked ? 0.55 : 1,
              }}
              title={
                finalLockInTooltip ??
                (hasConsented
                  ? "You've locked in. Click to unlock and re-open allocation."
                  : "Click to lock in — confirms the subtask allocation and starts work.")
              }
            >
              {hasConsented ? "✓ Locked in" : "Lock in"}
            </button>
          )}
          {!isSealed && !isSetup && isAdmin && requiredCount > 0 && !consensus.allConsented && (
            <button
              type="button"
              onClick={handleForceSeal}
              disabled={busy}
              style={ghostBtn}
              title="Admin: seal without waiting for unanimous lock-in"
            >
              Force-seal
            </button>
          )}
          {isSealed && isAdmin && (
            <button
              type="button"
              onClick={handleUnseal}
              disabled={busy}
              style={ghostBtn}
              title="Admin: re-open this block and reset the lock-in tally"
            >
              Unseal
            </button>
          )}
          {isSealed && isAdmin && missingReviewerCount > 0 && (
            <button
              type="button"
              onClick={handleSpawnMissing}
              disabled={busy}
              style={{ ...ghostBtn, color: "var(--color-warning, var(--color-accent))" }}
              title={`Admin: spawn ${missingReviewerCount} missing reviewer signoff row${missingReviewerCount === 1 ? "" : "s"} for this sealed block`}
            >
              Spawn {missingReviewerCount} review{missingReviewerCount === 1 ? "" : "s"}
            </button>
          )}
          {canEditStructure && (isAdmin || isCreator) && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              style={{ ...ghostBtn, color: "var(--color-danger)" }}
              title="Delete block (subtasks move to ungrouped)"
              aria-label={`Delete block "${block.name}"`}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {!isSealed && !isSetup && requiredCount > 0 && (
        <div
          style={{
            height: "4px",
            borderRadius: "2px",
            background: "var(--color-bg)",
            overflow: "hidden",
          }}
          aria-hidden="true"
        >
          <div
            style={{
              height: "100%",
              width: `${(consentCount / requiredCount) * 100}%`,
              background: consensus.allConsented
                ? "var(--color-success, #16a34a)"
                : "var(--color-accent)",
              transition: "width 180ms ease-out",
            }}
          />
        </div>
      )}
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--color-border)",
  color: "var(--color-text-muted)",
  padding: "0.25rem 0.6rem",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  cursor: "pointer",
};
