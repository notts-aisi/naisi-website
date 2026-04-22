"use client";

import { useMemo, useState } from "react";
import {
  TASK_FIELD_LIMITS,
  effectiveReviewerUids,
  getReviewerGlobalCoverage,
  getReviewerSignoffBlockers,
  getSubtaskApprovalStatus,
  isSubtaskBlocked,
  subtaskRowState,
  type RowState,
  type Subtask,
  type TaskDoc,
} from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import {
  forceSealSubtask,
  removeSubtask,
  renameSubtask,
  selfAddToSubtask,
  selfRemoveFromSubtask,
  setSubtaskApproval,
  setSubtaskAssignees,
  setSubtaskBlock,
  setSubtaskBlockedBy,
  setSubtaskReviewers,
  toggleSubtask,
  unsealSubtask,
  type ReviewState,
} from "../taskMutations";
import AssigneePicker from "./AssigneePicker";

type Props = {
  task: TaskDoc;
  subtask: Subtask;
  users: UserDoc[];
  viewerUid: string;
  /** Controls visibility of the subtask-level seal/unseal escape hatch.
   *  Admin-only in PR 1; might widen to creator later. */
  isAdmin: boolean;
  /** True when the viewer can freely rewrite the subtask's assignee /
   *  reviewer rosters — admin or task creator only per the Phase 3
   *  permission matrix. Completers modify their own membership via the
   *  `+ Me` / `− Me` affordances instead; reviewers and non-involved
   *  users see a read-only list. */
  canEditRoster: boolean;
  canEdit: boolean;
  /** Whether the viewer can see the reviewer columns. Completers + non-
   *  involved committee members get this `false` — they see the row's
   *  aggregate colour state but not the per-reviewer grid. */
  showMatrix: boolean;
  /** True when a sent_for_review is pending resolution for this specific
   *  subtask (derived in the parent from the activity feed). Drives the
   *  orange row tint while approvals are incoming. */
  isReviewPending: boolean;
  /** Optional drag handle rendered on the left when the row is sortable. */
  dragHandle?: React.ReactNode;
};

const selfBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "var(--color-accent-soft)",
  color: "var(--color-accent)",
  border: "none",
  borderRadius: "999px",
  fontSize: "10px",
  fontWeight: 600,
  cursor: "pointer",
  letterSpacing: "0.02em",
};

const adminBtn: React.CSSProperties = {
  padding: "0.3rem 0.65rem",
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
  borderRadius: "var(--radius-sm, 4px)",
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  cursor: "pointer",
};

const ROW_COLOURS: Record<RowState, { border: string; bg: string | null }> = {
  neutral: { border: "var(--color-border)", bg: null },
  blue: { border: "var(--color-accent)", bg: "var(--color-accent-soft)" },
  orange: {
    border: "var(--color-warning, var(--color-accent))",
    bg: "var(--color-warning-soft, var(--color-surface-hover))",
  },
  green: {
    border: "var(--color-success, #16a34a)",
    bg: "var(--color-success-soft, rgba(22, 163, 74, 0.08))",
  },
  red: {
    border: "var(--color-danger, #dc2626)",
    bg: "var(--color-danger-soft, rgba(220, 38, 38, 0.08))",
  },
};

export default function SubtaskRow({
  task,
  subtask,
  users,
  viewerUid,
  isAdmin,
  canEditRoster,
  canEdit,
  showMatrix,
  isReviewPending,
  dragHandle,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);

  const blocked = !subtask.done && isSubtaskBlocked(subtask, task.subtasks, task.reviewerUids);
  // Reviewer-signoff gate: the viewer can only tick their own signoff once
  // every block-mate they're required to review is done + approved by them.
  // Computed here for checkbox disable/tooltip; `toggleSubtask` enforces it
  // server-side-adjacent as well.
  const signoffBlockers =
    subtask.roleHint === "reviewer" &&
    !subtask.done &&
    subtask.reviewerUids.includes(viewerUid)
      ? getReviewerSignoffBlockers(task, subtask, viewerUid)
      : [];
  const signoffBlocked = signoffBlockers.length > 0;
  const signoffTooltip = signoffBlocked
    ? `Approve every completion row in this block first — waiting on: ${signoffBlockers
        .slice(0, 3)
        .map((b) => `"${b.title}"`)
        .join(", ")}${signoffBlockers.length > 3 ? ` (+${signoffBlockers.length - 3} more)` : ""}`
    : null;
  const parentBlock = subtask.blockId
    ? task.blocks.find((b) => b.id === subtask.blockId) ?? null
    : null;
  const parentSealed = parentBlock?.sealState === "sealed";
  const subtaskSealed = subtask.sealState === "sealed";
  const rosterLocked = subtaskSealed || parentSealed;
  const isCompleter = task.completerUids.includes(viewerUid);
  const isSelfAssigned = subtask.assigneeUids.includes(viewerUid);
  const isTaskCreator = task.creatorUid === viewerUid;
  // Permission to toggle the checkbox. Mirrors the guard in `toggleSubtask`:
  //   - Reviewer-signoff row: only the listed reviewer.
  //   - Regular completion row: only a listed assignee (or task creator as
  //     an always-available escape hatch). Empty `assigneeUids` = any
  //     completer on the task may tick.
  const canToggleRow =
    subtask.roleHint === "reviewer"
      ? subtask.reviewerUids.includes(viewerUid)
      : isTaskCreator ||
        isSelfAssigned ||
        (subtask.assigneeUids.length === 0 && isCompleter);
  // Self-remove is allowed only when nothing is sealed. Self-add remains
  // allowed post-block-seal (cover-for-sick path) but is gated by subtask-
  // level seal — a subtask admin-sealed is frozen both ways.
  const canSelfRemove = isCompleter && isSelfAssigned && !rosterLocked;
  const canSelfAdd = isCompleter && !isSelfAssigned && !subtaskSealed;
  const blockers = useMemo(
    () =>
      subtask.blockedBy
        .map((id) => task.subtasks.find((s) => s.id === id))
        .filter((s): s is Subtask => Boolean(s)),
    [subtask.blockedBy, task.subtasks],
  );
  const siblings = task.subtasks.filter((s) => s.id !== subtask.id);

  const assignees = useMemo(
    () =>
      subtask.assigneeUids
        .map((uid) => users.find((u) => u.uid === uid))
        .filter((u): u is UserDoc => Boolean(u)),
    [subtask.assigneeUids, users],
  );

  const reviewers = useMemo(() => {
    const uids = effectiveReviewerUids(subtask, task.reviewerUids);
    return uids
      .map((uid) => users.find((u) => u.uid === uid) ?? { uid, displayName: null, email: null, role: "member" } as UserDoc)
      .filter(Boolean) as UserDoc[];
  }, [subtask, task.reviewerUids, users]);

  const approvalStatus = useMemo(
    () => getSubtaskApprovalStatus(subtask, task.reviewerUids),
    [subtask, task.reviewerUids],
  );

  const rowState = subtaskRowState(subtask, task.reviewerUids, isReviewPending);
  const rowPalette = ROW_COLOURS[rowState];

  // Final-signoff detection — clicking Approve in this row's matrix would
  // push the viewer's global approval coverage from N-1/N to N/N. Passed
  // down so the ApprovalCell's approve handler can pop a confirm. Only
  // meaningful when the viewer is an effective reviewer on this row and
  // hasn't already approved it.
  const viewerIsReviewerHere = approvalStatus.required.includes(viewerUid);
  const viewerAlreadyApprovedHere = subtask.approvedByReviewerUids.includes(viewerUid);
  const coverage = viewerIsReviewerHere
    ? getReviewerGlobalCoverage(task, viewerUid)
    : { approved: 0, required: 0 };
  const approveWillFinalise =
    viewerIsReviewerHere &&
    !viewerAlreadyApprovedHere &&
    coverage.required > 0 &&
    coverage.approved + 1 === coverage.required;

  async function handleDelete() {
    const ok = window.confirm(
      `Delete subtask "${subtask.title}"? This also clears any other subtask's dependency on it.`,
    );
    if (!ok) return;
    try {
      await removeSubtask(task, subtask.id);
    } catch (err) {
      console.error(err);
    }
  }

  /**
   * Checkbox wrapper. On reviewer-signoff rows (`roleHint: "reviewer"`) the
   * tick IS the reviewer's approval, so if this tick would transition them
   * from N-1/N to N/N coverage globally across the task, pop the
   * final-signoff confirmation before writing. Non-reviewer rows short-
   * circuit straight through to toggleSubtask.
   */
  async function handleCheckboxToggle() {
    const willTurnOn = !subtask.done;
    if (willTurnOn && subtask.roleHint === "reviewer") {
      const isRequiredHere = effectiveReviewerUids(subtask, task.reviewerUids).includes(
        viewerUid,
      );
      if (isRequiredHere) {
        const coverage = getReviewerGlobalCoverage(task, viewerUid);
        if (coverage.required > 0 && coverage.approved === coverage.required - 1) {
          const ok = window.confirm(
            "This is your final signoff on this task — confirm?",
          );
          if (!ok) return;
        }
      }
    }
    try {
      await toggleSubtask(task, subtask.id);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleTitleBlur() {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === subtask.title) {
      setTitleDraft(subtask.title);
      return;
    }
    try {
      await renameSubtask(task, subtask.id, trimmed);
    } catch (err) {
      console.error(err);
      setTitleDraft(subtask.title);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "0.85rem 1rem",
        background: rowPalette.bg ?? "var(--color-bg-elevated)",
        border: `1px solid ${rowPalette.border}`,
        borderLeftWidth: "3px",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minHeight: "2rem" }}>
        {dragHandle}
        <input
          type="checkbox"
          checked={subtask.done}
          disabled={blocked || signoffBlocked || !canToggleRow}
          onChange={() => handleCheckboxToggle().catch(console.error)}
          aria-label={
            blocked
              ? `Blocked — waiting on ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : signoffBlocked
                ? signoffTooltip ?? "Signoff gated on outstanding approvals"
                : !canToggleRow
                  ? notPermittedTooltip(subtask)
                  : `Mark "${subtask.title}" ${subtask.done ? "incomplete" : "complete"}`
          }
          title={
            blocked
              ? `Waiting on: ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : signoffTooltip ??
                (!canToggleRow ? notPermittedTooltip(subtask) : undefined)
          }
        />
        <span
          style={{
            flex: 1,
            fontSize: "var(--text-sm)",
            textDecoration: subtask.done ? "line-through" : "none",
            color: subtask.done ? "var(--color-text-muted)" : "var(--color-text)",
          }}
        >
          {subtask.title}
        </span>

        {subtask.roleHint === "reviewer" && (
          <span
            title="Auto-spawned on block seal — ticking this is the reviewer's signoff."
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              borderRadius: "999px",
              background: "var(--color-warning-soft, var(--color-surface-hover))",
              color: "var(--color-warning, var(--color-text))",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Reviewer signoff
          </span>
        )}

        <InlineAvatars users={assignees} tone="accent" title="Assignees" />

        {/* Completer self-service: quick add/remove me, without opening
            the Edit panel. Hidden when the viewer isn't a completer or
            when roster lock (subtask-seal or block-seal with existing
            membership) forbids the direction they'd move in. */}
        {canSelfAdd && (
          <button
            type="button"
            onClick={() => selfAddToSubtask(task, subtask.id).catch(console.error)}
            style={selfBtn}
            title={
              parentSealed
                ? "Block is sealed, but self-add is still allowed (cover-for-sick path)."
                : "Add me to this subtask"
            }
          >
            + Me
          </button>
        )}
        {canSelfRemove && (
          <button
            type="button"
            onClick={() => selfRemoveFromSubtask(task, subtask.id).catch(console.error)}
            style={selfBtn}
            title="Remove me from this subtask"
          >
            − Me
          </button>
        )}
        {subtaskSealed && (
          <span
            title="Admin-sealed — roster frozen"
            aria-label="Subtask is sealed"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "2px 6px",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: "999px",
              fontSize: "10px",
              color: "var(--color-text-muted)",
              fontWeight: 600,
            }}
          >
            🔒
          </span>
        )}

        {/* Hide the per-reviewer matrix on reviewer-signoff rows — the
            checkbox IS the approval there, no grid needed. */}
        {showMatrix && reviewers.length > 0 && subtask.roleHint !== "reviewer" && (
          <ApprovalMatrixRow
            reviewers={reviewers}
            approvedUids={subtask.approvedByReviewerUids}
            questionedUids={subtask.questionedByReviewerUids}
            rejectedUids={subtask.rejectedByReviewerUids}
            viewerUid={viewerUid}
            approveWillFinalise={approveWillFinalise}
            onSet={(state) =>
              setSubtaskApproval(task, subtask.id, state).catch(console.error)
            }
          />
        )}

        {canEdit && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginLeft: "var(--space-2)" }}>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-label={editing ? "Close subtask editor" : "Edit subtask"}
              style={{
                background: "transparent",
                border: "none",
                color: editing ? "var(--color-accent)" : "var(--color-text-muted)",
                cursor: "pointer",
                fontSize: "var(--text-xs)",
                fontWeight: 500,
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--radius-sm, 4px)",
              }}
            >
              {editing ? "Done" : "Edit"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              aria-label={`Delete subtask "${subtask.title}"`}
              title="Delete subtask"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-danger)",
                cursor: "pointer",
                fontSize: "var(--text-sm)",
                fontWeight: 600,
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--radius-sm, 4px)",
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {blocked && blockers.length > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            fontWeight: 500,
            color: "var(--color-warning, var(--color-text))",
          }}
        >
          Waiting on: {blockers.map((b) => b.title).join(" • ")}
        </p>
      )}

      {signoffBlocked && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            color: "var(--color-warning, var(--color-text))",
          }}
        >
          Approve first: {signoffBlockers.map((b) => b.title).join(" • ")}
        </p>
      )}

      {showMatrix && approvalStatus.required.length > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
          }}
        >
          {approvalStatus.approved.length} / {approvalStatus.required.length} approved
          {approvalStatus.questioned.length > 0 &&
            ` · ${approvalStatus.questioned.length} open question${approvalStatus.questioned.length === 1 ? "" : "s"}`}
        </p>
      )}

      {editing && canEdit && (
        <div
          style={{
            display: "grid",
            gap: "var(--space-3)",
            gridTemplateColumns: "1fr 1fr",
            marginTop: "var(--space-2)",
            paddingTop: "var(--space-2)",
            borderTop: "1px dashed var(--color-border)",
          }}
        >
          <label style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              Title
            </span>
            <input
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleBlur}
              maxLength={TASK_FIELD_LIMITS.subtaskTitle}
              style={{
                padding: "0.4rem 0.6rem",
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                color: "var(--color-text)",
                fontSize: "var(--text-sm)",
              }}
            />
          </label>

          <div>
            {canEditRoster ? (
              <AssigneePicker
                users={users}
                selected={subtask.assigneeUids}
                onChange={(uids) =>
                  setSubtaskAssignees(task, subtask.id, uids).catch((err) => {
                    console.error(err);
                    window.alert(err instanceof Error ? err.message : "Update failed");
                  })
                }
                label={
                  subtaskSealed
                    ? "Assignees (subtask sealed — admin must unseal)"
                    : "Assignees on this step (must be task completers)"
                }
                max={TASK_FIELD_LIMITS.maxAssigneesPerSubtask}
                role="completer"
                limitToUids={task.completerUids}
                emptyLimitHint="Add completers to the task first — subtask assignees must already be on the task."
              />
            ) : (
              <ReadOnlyRoster
                users={users}
                uids={subtask.assigneeUids}
                label="Assignees on this step"
                emptyText="No one assigned — use + Me to self-assign."
                tone="accent"
              />
            )}
          </div>
          <div>
            {canEditRoster ? (
              <AssigneePicker
                users={users}
                selected={subtask.reviewerUids}
                onChange={(uids) => setSubtaskReviewers(task, subtask.id, uids).catch(console.error)}
                label="Reviewers (leave empty to inherit from task)"
                max={TASK_FIELD_LIMITS.maxReviewersPerSubtask}
                role="reviewer"
                limitToUids={task.reviewerUids}
                emptyLimitHint="Add reviewers to the task first — subtask reviewers must already be on the task."
              />
            ) : (
              <ReadOnlyRoster
                users={users}
                uids={subtask.reviewerUids}
                label="Reviewers (inherited from task if empty)"
                emptyText={
                  task.reviewerUids.length > 0
                    ? "Inheriting task-level reviewers."
                    : "No reviewers set."
                }
                tone="warning"
              />
            )}
          </div>

          {task.blocks.length > 0 && (
            <label
              style={{
                gridColumn: "span 2",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Block
              </span>
              <select
                value={subtask.blockId ?? ""}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setSubtaskBlock(task, subtask.id, next).catch(console.error);
                }}
                style={{
                  padding: "0.4rem 0.6rem",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  color: "var(--color-text)",
                  fontSize: "var(--text-sm)",
                }}
              >
                <option value="">— Ungrouped —</option>
                {task.blocks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.sealState === "sealed" ? " (sealed)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isAdmin && (
            <div
              style={{
                gridColumn: "span 2",
                display: "flex",
                gap: "var(--space-2)",
                alignItems: "center",
                padding: "var(--space-2)",
                background: "var(--color-bg)",
                border: "1px dashed var(--color-border)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", flex: 1 }}>
                Admin:{" "}
                {subtaskSealed
                  ? "subtask is sealed — roster is frozen independently of its block."
                  : "subtask roster follows its block's seal state (or stays editable if no block)."}
              </span>
              {subtaskSealed ? (
                <button
                  type="button"
                  onClick={() =>
                    unsealSubtask(task, subtask.id).catch((err) => {
                      console.error(err);
                      window.alert(err instanceof Error ? err.message : "Unseal failed");
                    })
                  }
                  style={adminBtn}
                >
                  Unseal subtask
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const ok = window.confirm(
                      `Freeze the assignee list on "${subtask.title}"? Independent of its block — useful when one row is firmly decided.`,
                    );
                    if (!ok) return;
                    forceSealSubtask(task, subtask.id).catch((err) => {
                      console.error(err);
                      window.alert(err instanceof Error ? err.message : "Seal failed");
                    });
                  }}
                  style={adminBtn}
                >
                  Seal subtask
                </button>
              )}
            </div>
          )}

          {siblings.length > 0 && (
            <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
                Blocked by (must be done + approved first)
              </span>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                  padding: "var(--space-2)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--color-bg)",
                }}
              >
                {siblings.map((sib) => {
                  const checked = subtask.blockedBy.includes(sib.id);
                  return (
                    <label
                      key={sib.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        fontSize: "var(--text-xs)",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? subtask.blockedBy.filter((id) => id !== sib.id)
                            : [...subtask.blockedBy, sib.id];
                          setSubtaskBlockedBy(task, subtask.id, next).catch(console.error);
                        }}
                      />
                      <span style={{ color: "var(--color-text-muted)" }}>{sib.title}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only roster list shown in the subtask Edit panel for viewers who
 * aren't allowed to rewrite roster arrays wholesale. Completers and
 * reviewers who just need to view the assignments (and use +Me/−Me for
 * their own self-service edits) see this instead of the editable picker.
 */
function ReadOnlyRoster({
  users,
  uids,
  label,
  emptyText,
  tone,
}: {
  users: UserDoc[];
  uids: string[];
  label: string;
  emptyText: string;
  tone: "accent" | "warning";
}) {
  const resolved = uids
    .map((uid) => users.find((u) => u.uid === uid))
    .filter((u): u is UserDoc => Boolean(u));
  const chipBg =
    tone === "warning"
      ? "var(--color-warning-soft, var(--color-surface-hover))"
      : "var(--color-accent-soft)";
  const chipFg =
    tone === "warning"
      ? "var(--color-warning, var(--color-text))"
      : "var(--color-accent)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
        {label}
      </span>
      {resolved.length === 0 ? (
        <span
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--color-text-subtle)",
            fontStyle: "italic",
          }}
        >
          {emptyText}
        </span>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
          {resolved.map((u) => (
            <span
              key={u.uid}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "0.25rem 0.55rem",
                borderRadius: "var(--radius-pill)",
                background: chipBg,
                color: chipFg,
                fontSize: "var(--text-xs)",
              }}
            >
              {u.displayName ?? u.email ?? u.uid}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function notPermittedTooltip(s: Subtask): string {
  if (s.roleHint === "reviewer") {
    return "Only the listed reviewer can toggle this signoff row.";
  }
  if (s.assigneeUids.length === 0) {
    return "Only task completers can tick this subtask.";
  }
  return "This subtask is assigned to specific people — only they can tick it.";
}

function InlineAvatars({
  users,
  tone,
  title,
}: {
  users: UserDoc[];
  tone: "accent" | "warning";
  title: string;
}) {
  if (users.length === 0) return null;
  const bg = tone === "warning"
    ? "var(--color-warning-soft, var(--color-surface-hover))"
    : "var(--color-accent-soft)";
  const fg = tone === "warning"
    ? "var(--color-warning, var(--color-text))"
    : "var(--color-accent)";
  return (
    <span
      title={`${title}: ${users.map((u) => u.displayName ?? u.email ?? u.uid).join(", ")}`}
      style={{ display: "inline-flex", gap: "2px" }}
    >
      {users.slice(0, 3).map((u) => (
        <span
          key={u.uid}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.25rem",
            height: "1.25rem",
            borderRadius: "50%",
            background: bg,
            color: fg,
            fontSize: "10px",
            fontWeight: 600,
          }}
        >
          {(u.displayName ?? u.email ?? "?").charAt(0).toUpperCase()}
        </span>
      ))}
      {users.length > 3 && (
        <span style={{ fontSize: "10px", color: "var(--color-text-subtle)" }}>+{users.length - 3}</span>
      )}
    </span>
  );
}

/**
 * Derive first+last initials from a user. "John Smith" → "JS".
 * Single-word handles fall back to first two chars — "jsmith" → "JS".
 * Unknowns fall back to "?".
 */
function getInitials(u: UserDoc): string {
  const src = u.displayName ?? u.email ?? u.uid;
  if (!src) return "?";
  const parts = src.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

/**
 * Per-reviewer approval cells on a subtask row. Leading "Review" label gives
 * the grid a recognisable anchor so the columns aren't floating mystery
 * glyphs. All cells share the same box-sizing / border-width so the row
 * doesn't jitter when the viewer's own cell renders as a button (1px border)
 * while others render as static spans.
 */
type CellState = "approved" | "question" | "rejected" | "empty";

function ApprovalMatrixRow({
  reviewers,
  approvedUids,
  questionedUids,
  rejectedUids,
  viewerUid,
  approveWillFinalise,
  onSet,
}: {
  reviewers: UserDoc[];
  approvedUids: string[];
  questionedUids: string[];
  rejectedUids: string[];
  viewerUid: string;
  approveWillFinalise: boolean;
  onSet: (state: ReviewState) => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        padding: "2px 6px",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm, 4px)",
        background: "var(--color-bg)",
      }}
    >
      <span
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--color-text-subtle)",
          marginRight: "2px",
        }}
      >
        Review
      </span>
      {reviewers.map((r) => {
        const state: CellState = approvedUids.includes(r.uid)
          ? "approved"
          : rejectedUids.includes(r.uid)
            ? "rejected"
            : questionedUids.includes(r.uid)
              ? "question"
              : "empty";
        const isMine = r.uid === viewerUid;
        return (
          <ApprovalCell
            key={r.uid}
            reviewer={r}
            state={state}
            isMine={isMine}
            approveWillFinalise={isMine && approveWillFinalise}
            onSet={onSet}
          />
        );
      })}
    </span>
  );
}

function ApprovalCell({
  reviewer,
  state,
  isMine,
  approveWillFinalise,
  onSet,
}: {
  reviewer: UserDoc;
  state: CellState;
  isMine: boolean;
  approveWillFinalise: boolean;
  onSet: (state: ReviewState) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = reviewer.displayName ?? reviewer.email ?? reviewer.uid;
  const initials = getInitials(reviewer);

  const icon =
    state === "approved"
      ? "✓"
      : state === "question"
        ? "❓"
        : state === "rejected"
          ? "✕"
          : initials;
  const color =
    state === "approved"
      ? "var(--color-success, #16a34a)"
      : state === "question"
        ? "var(--color-warning, var(--color-accent))"
        : state === "rejected"
          ? "var(--color-danger, #dc2626)"
          : "var(--color-text-subtle)";
  const bg =
    state === "approved"
      ? "var(--color-success-soft, rgba(22, 163, 74, 0.12))"
      : state === "question"
        ? "var(--color-warning-soft, var(--color-surface-hover))"
        : state === "rejected"
          ? "var(--color-danger-soft, rgba(220, 38, 38, 0.12))"
          : "transparent";

  // Both variants share the exact same box model so cells don't jitter when
  // the viewer's own cell gets a visible border while others don't. We apply
  // a `transparent` border to the read-only span of the same width as the
  // button's border + box-sizing:border-box on both.
  const sharedCellStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.75rem",
    height: "1.5rem",
    borderRadius: "var(--radius-sm, 4px)",
    background: bg,
    color,
    fontSize: "10px",
    fontWeight: 700,
    boxSizing: "border-box",
    border: "1px solid transparent",
    lineHeight: 1,
  };

  const stateCopy: Record<CellState, string> = {
    empty: "not yet reviewed",
    approved: "approved",
    question: "has a question",
    rejected: "rejected",
  };
  if (!isMine) {
    return (
      <span
        title={`${label}: ${stateCopy[state]}`}
        aria-label={`${label} ${state}`}
        style={{ ...sharedCellStyle, cursor: "default" }}
      >
        {icon}
      </span>
    );
  }

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Your review — ${state === "empty" ? "click to set" : `currently ${state}`}`}
        aria-label={`Set your review state (currently ${state})`}
        style={{
          ...sharedCellStyle,
          borderColor: "var(--color-border)",
          cursor: "pointer",
          padding: 0,
        }}
      >
        {icon}
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 5,
            minWidth: "9rem",
            padding: "0.25rem",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
          }}
        >
          <ApprovalMenuItem
            icon="✓"
            label={approveWillFinalise ? "Approve (final signoff)" : "Approve"}
            onClick={() => {
              if (approveWillFinalise) {
                const ok = window.confirm(
                  "This ✓ is your final approval on this task — confirm signoff?",
                );
                if (!ok) {
                  setOpen(false);
                  return;
                }
              }
              onSet("approve");
              setOpen(false);
            }}
            active={state === "approved"}
          />
          <ApprovalMenuItem
            icon="❓"
            label="Have question"
            onClick={() => {
              onSet("question");
              setOpen(false);
            }}
            active={state === "question"}
          />
          <ApprovalMenuItem
            icon="✕"
            label="Reject"
            onClick={() => {
              onSet("reject");
              setOpen(false);
            }}
            active={state === "rejected"}
          />
          <ApprovalMenuItem
            icon="⬜"
            label="Clear"
            onClick={() => {
              onSet("clear");
              setOpen(false);
            }}
            active={state === "empty"}
          />
        </div>
      )}
    </span>
  );
}

function ApprovalMenuItem({
  icon,
  label,
  onClick,
  active,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0.3rem 0.55rem",
        background: active ? "var(--color-surface-hover)" : "transparent",
        color: "var(--color-text)",
        border: "none",
        fontSize: "var(--text-sm)",
        cursor: "pointer",
        textAlign: "left",
        borderRadius: "var(--radius-sm, 4px)",
      }}
    >
      <span style={{ width: "1rem", textAlign: "center" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
