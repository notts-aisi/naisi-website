"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import { maxWidth } from "@/theme/breakpoints";
import {
  TASK_FIELD_LIMITS,
  effectiveReviewerUids,
  getReviewerBlockCoverage,
  getReviewerGlobalCoverage,
  getReviewerSignoffBlockers,
  getSubtaskApprovalStatus,
  hasReviewerSignedOffBlock,
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
  resubmitSubtask,
  selfAddReviewerToSubtask,
  selfAddToSubtask,
  selfRemoveFromSubtask,
  selfRemoveReviewerFromSubtask,
  setSubtaskApproval,
  setSubtaskAssignees,
  setSubtaskBlock,
  setSubtaskBlockedBy,
  setSubtaskReviewers,
  toggleSubtask,
  unsealSubtask,
  type ReviewState,
} from "../taskMutations";
import { addComment } from "../commentMutations";
import PersonSelector from "@/components/ui/PersonSelector";
import SubtaskDetailModal from "./SubtaskDetailModal";
import rowStyles from "./SubtaskRow.module.css";

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
  /** True when the viewer can edit the subtask description. Mirrors the
   *  task-level `canEditStructure` (admin / committee on committee tasks /
   *  creator on personal). Non-editors still open the detail modal — they
   *  just see the description read-only. */
  canEditStructure: boolean;
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

// Whether a subtask's due date has passed. The clock read lives in this
// plain helper so the component render body stays free of the impure call.
function isSubtaskOverdue(subtask: Subtask): boolean {
  return (
    !subtask.done &&
    subtask.dueDate != null &&
    subtask.dueDate.getTime() < Date.now()
  );
}

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

const reviewerSelfBtn: React.CSSProperties = {
  padding: "2px 8px",
  background: "var(--color-warning-soft, var(--color-surface-hover))",
  color: "var(--color-warning, var(--color-text))",
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
  canEditStructure,
  showMatrix,
  isReviewPending,
  dragHandle,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(subtask.title);
  // Rejection-reason composer. `null` = dialog closed. Non-null string =
  // open with that draft value. Intercepts the ❌ menu click so reviewers
  // always accompany a reject with a reason that's emailed to completers.
  const [rejectReasonDraft, setRejectReasonDraft] = useState<string | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  // Phone-shape gate. Below --bp-md the row's inline action buttons
  // (+Me / −Me / +Review / −Review / Edit / Delete) migrate into
  // SubtaskDetailModal as proper-sized tap targets; the row stays a
  // tap-to-open card. Pattern mirrors PersonSelector.tsx.
  const mobileSubscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(maxWidth("md"));
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const isMobile = useSyncExternalStore(
    mobileSubscribe,
    () => window.matchMedia(maxWidth("md")).matches,
    () => false,
  );

  const blocked = !subtask.done && isSubtaskBlocked(subtask, task);
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
  // Reviewer signoffs are sticky once ticked — only an admin can untick.
  // Drives checkbox disable + the "only an admin can retract" hint below.
  const signoffRetractLocked =
    subtask.roleHint === "reviewer" && subtask.done && !isAdmin;
  // Once the viewer has ticked their signoff row for this block, their
  // per-subtask review cells are frozen. Admin can still act (they can
  // force-untick a signoff to unlock). Non-signoff rows on other blocks
  // unaffected.
  const viewerFrozenOnBlock =
    subtask.roleHint !== "reviewer" &&
    subtask.blockId !== null &&
    !isAdmin &&
    hasReviewerSignedOffBlock(task, subtask.blockId, viewerUid);
  const parentBlock = subtask.blockId
    ? task.blocks.find((b) => b.id === subtask.blockId) ?? null
    : null;
  const parentSealed = parentBlock?.sealState === "sealed";
  const subtaskSealed = subtask.sealState === "sealed";
  const rosterLocked = subtaskSealed || parentSealed;
  const isCompleter = task.completerUids.includes(viewerUid);
  const isSelfAssigned = subtask.assigneeUids.includes(viewerUid);
  const isTaskCreator = task.creatorUid === viewerUid;
  // Stage 1.5a gap-fix: completion-row work can't start before the parent
  // block's allocation is locked in. Admin bypass preserved.
  const preSealWorkLocked =
    subtask.roleHint !== "reviewer" &&
    subtask.blockId !== null &&
    parentBlock !== null &&
    !parentSealed &&
    !isAdmin &&
    !subtask.done;
  // Stage 1.9c: once reviewer signoff rows exist in the parent block,
  // completers can't un-tick their done subtasks — the handoff to
  // reviewers has happened. Leave comments on the subtask instead.
  // Admin bypass.
  const postNotifyUntickLocked =
    subtask.roleHint !== "reviewer" &&
    subtask.blockId !== null &&
    parentSealed &&
    subtask.done &&
    !isAdmin &&
    task.subtasks.some(
      (s) => s.blockId === subtask.blockId && s.roleHint === "reviewer",
    );
  // Permission to toggle the checkbox. Mirrors the guard in `toggleSubtask`
  // (Stage 1.5a): reviewer rows are listed-reviewer-only; completion rows
  // are admin OR listed assignee OR (empty-assignees open to any listed
  // completer). Creator bypass dropped 2026-04-23 — creators who want to
  // move work forward should self-add via `+ Me`.
  const canToggleRow =
    subtask.roleHint === "reviewer"
      ? subtask.reviewerUids.includes(viewerUid)
      : isAdmin ||
        isSelfAssigned ||
        (subtask.assigneeUids.length === 0 && isCompleter);
  // Self-remove is allowed only when nothing is sealed. Self-add remains
  // allowed post-block-seal (cover-for-sick path) but is gated by subtask-
  // level seal — a subtask admin-sealed is frozen both ways.
  const canSelfRemove = isCompleter && isSelfAssigned && !rosterLocked;
  // Stage 1.9a gap-fix: hide +Me on reviewer-signoff rows so completers
  // don't see an affordance they can't use (server-side already rejects).
  const canSelfAdd =
    isCompleter &&
    !isSelfAssigned &&
    !subtaskSealed &&
    subtask.roleHint !== "reviewer";
  // Stage 1.9b: reviewer self-service on completion rows. Anyone on the
  // task's reviewer roster can claim/drop review scope per-subtask.
  // Post-Notify: add still OK (via confirm popup), remove admin-only.
  const isTaskLevelReviewer = task.reviewerUids.includes(viewerUid);
  const isReviewerOnSubtask = subtask.reviewerUids.includes(viewerUid);
  const blockHasSignoffs =
    subtask.blockId !== null &&
    task.subtasks.some(
      (s) => s.blockId === subtask.blockId && s.roleHint === "reviewer",
    );
  // Skip-review blocks have no review pass — claiming review scope on a
  // subtask inside one is a no-op affordance, so hide the +Review button.
  const parentBlockSkipsReview = parentBlock?.reviewMode === "skip-review";
  const canSelfAddReviewer =
    subtask.roleHint !== "reviewer" &&
    isTaskLevelReviewer &&
    !isReviewerOnSubtask &&
    !subtaskSealed &&
    !parentBlockSkipsReview;
  const canSelfRemoveReviewer =
    subtask.roleHint !== "reviewer" &&
    isTaskLevelReviewer &&
    isReviewerOnSubtask &&
    !subtaskSealed &&
    (isAdmin || !blockHasSignoffs);
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
    // Stage 2 (2026-04-24): strict — only show reviewers who have
    // explicitly claimed this subtask (no task-level fallback). Matches
    // the `setSubtaskApproval` gate so the matrix only shows cells the
    // viewer can actually interact with.
    return subtask.reviewerUids
      .map((uid) => users.find((u) => u.uid === uid) ?? { uid, displayName: null, email: null, role: "member" } as UserDoc)
      .filter(Boolean) as UserDoc[];
  }, [subtask.reviewerUids, users]);

  const approvalStatus = useMemo(
    () => getSubtaskApprovalStatus(subtask, task.reviewerUids),
    [subtask, task.reviewerUids],
  );

  // Reviewer-signoff rows can't use approvalStatus for the "X / N approved"
  // counter — their `approvedByReviewerUids` is always empty (they're
  // ticked via `done`, not the matrix). Substitute a block-scoped coverage
  // count for the assigned reviewer so the counter actually moves as they
  // approve their block-mates.
  const signoffCoverage = useMemo(() => {
    if (subtask.roleHint !== "reviewer") return null;
    if (subtask.blockId === null) return null;
    if (subtask.reviewerUids.length === 0) return null;
    return getReviewerBlockCoverage(
      task,
      subtask.blockId,
      subtask.reviewerUids[0],
    );
  }, [subtask, task]);

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
      `Delete subtask "${subtask.title}"? Its comments, activity history, and attachments will be permanently removed too. Any other subtask blocked on this one will be un-blocked. This cannot be undone.`,
    );
    if (!ok) return;
    try {
      const report = await removeSubtask(task, subtask.id);
      console.info(
        `[removeSubtask] removed subtask + ${report.comments} comments, ${report.activity} activity entries, ${report.attachments} attachments`,
      );
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Delete failed");
    }
  }

  /**
   * Checkbox wrapper. On reviewer-signoff rows (`roleHint: "reviewer"`) the
   * tick IS the reviewer's approval, so if this tick would transition them
   * from N-1/N to N/N coverage globally across the task, pop the
   * final-signoff confirmation before writing. Non-reviewer rows short-
   * circuit straight through to toggleSubtask. Admins bypass the
   * reviewer-only gating via `asAdmin` — necessary for retracting a
   * signoff (which only admins may do).
   */
  async function handleCheckboxToggle() {
    const willTurnOn = !subtask.done;
    if (willTurnOn && subtask.roleHint === "reviewer" && !isAdmin) {
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
      await toggleSubtask(task, subtask.id, { asAdmin: isAdmin });
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Could not toggle");
    }
  }

  /**
   * Matrix-popover ❌ click handler. Instead of writing the reject state
   * straight through, pop a required-reason dialog. On submit the dialog
   * posts a comment, emails completers, and THEN applies the reject state
   * — so a rejection in the UI always ships with context.
   *
   * Stage 2 (2026-04-23): if the reject-reason box is open and the reviewer
   * clicks a different state (misclick recovery), auto-close the box so
   * it doesn't linger while the row is no longer "rejecting".
   */
  async function handleSetReview(state: ReviewState) {
    if (state === "reject") {
      setRejectReasonDraft("");
      return;
    }
    if (rejectReasonDraft !== null) {
      setRejectReasonDraft(null);
    }
    // Optional note on approve/question — logged in the activity payload
    // so the subtask feed reads "X approved this subtask with note: ...".
    // Using window.prompt for MVP; polished inline UI is a follow-up.
    let note: string | undefined;
    if (state === "approve" || state === "question") {
      const entered = window.prompt(
        state === "approve"
          ? "Optional note for this approval (leave blank to skip):"
          : "Write your question (leave blank to just flag it):",
        "",
      );
      if (entered === null) return; // cancelled
      note = entered.trim() || undefined;
    }
    try {
      await setSubtaskApproval(task, subtask.id, state, note ? { note } : {});
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Review failed");
    }
  }

  async function submitRejection() {
    const reason = rejectReasonDraft?.trim() ?? "";
    if (!reason || rejectBusy) return;
    setRejectBusy(true);
    try {
      // Comment captures the rejection reason in-app; no email fires here.
      // Completers learn the outcome via the batched review email when the
      // reviewer presses "Send review" on the block (Stage 4). Comment
      // stays task-level so the existing thread surface keeps working
      // unchanged — only the per-rejection email is what's being removed.
      await addComment({
        taskId: task.id,
        bodyMarkdown: `**❌ Rejected "${subtask.title}"**\n\n${reason}`,
        mentions: [],
      });
      await setSubtaskApproval(task, subtask.id, "reject");
      setRejectReasonDraft(null);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Rejection failed");
    } finally {
      setRejectBusy(false);
    }
  }

  async function handleResubmit() {
    if (resendBusy) return;
    setResendBusy(true);
    try {
      await resubmitSubtask(task, subtask.id);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Resubmit failed");
    } finally {
      setResendBusy(false);
    }
  }

  async function handleSelfAddReviewer() {
    // Post-Notify takeover confirm: if the block has already been sent to
    // reviewers AND the subtask has existing reviewers, show a culture-
    // gate popup ("confirm you've spoken to them"). Pre-Notify or empty
    // reviewer list → skip the popup.
    if (blockHasSignoffs && subtask.reviewerUids.length > 0) {
      const names = subtask.reviewerUids
        .map((u) => {
          const user = users.find((x) => x.uid === u);
          return user?.displayName ?? user?.email ?? u;
        })
        .join(", ");
      const ok = window.confirm(
        `This block has been sent to reviewers. Confirm you've spoken to ${names} and they're OK with you taking over this review.`,
      );
      if (!ok) return;
    }
    try {
      await selfAddReviewerToSubtask(task, subtask.id);
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Couldn't add review scope");
    }
  }

  async function handleSelfRemoveReviewer() {
    try {
      await selfRemoveReviewerFromSubtask(task, subtask.id, { asAdmin: isAdmin });
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Couldn't drop review scope");
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
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => {
          // Keep Enter/Space as the only keyboard triggers — matches native
          // button semantics and avoids swallowing keystrokes meant for
          // nested inputs (e.g. the inline title rename field). Guard on
          // e.target === e.currentTarget so focus-on-child keys bubble
          // normally.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDetailOpen(true);
          }
        }}
        aria-label={`Open details for "${subtask.title}"`}
        className={rowStyles.row}
      >
        {dragHandle}
        <input
          type="checkbox"
          checked={subtask.done}
          disabled={
            blocked ||
            signoffBlocked ||
            signoffRetractLocked ||
            preSealWorkLocked ||
            postNotifyUntickLocked ||
            !canToggleRow
          }
          onClick={(e) => e.stopPropagation()}
          onChange={() => handleCheckboxToggle().catch(console.error)}
          aria-label={
            blocked
              ? `Blocked — waiting on ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : signoffBlocked
                ? signoffTooltip ?? "Signoff gated on outstanding approvals"
                : signoffRetractLocked
                  ? "Signoff already placed — only an admin can retract."
                  : preSealWorkLocked
                    ? "Lock in the block's allocation before starting work on its subtasks."
                    : postNotifyUntickLocked
                      ? "The block has been sent to reviewers — leave a comment on the subtask instead of un-ticking."
                      : !canToggleRow
                        ? notPermittedTooltip(subtask)
                        : `Mark "${subtask.title}" ${subtask.done ? "incomplete" : "complete"}`
          }
          title={
            blocked
              ? `Waiting on: ${blockers.map((b) => b.title).join(", ") || "earlier subtask"}`
              : signoffTooltip ??
                (signoffRetractLocked
                  ? "Your signoff is final — only an admin can retract it."
                  : preSealWorkLocked
                    ? "Lock in the block's allocation before starting work on its subtasks."
                    : postNotifyUntickLocked
                      ? "Please leave comments about your submission in the comments section of this subtask while it's under review."
                      : !canToggleRow
                        ? notPermittedTooltip(subtask)
                        : undefined)
          }
        />
        <span
          className={
            subtask.done
              ? `${rowStyles.titleArea} ${rowStyles.titleAreaDone}`
              : rowStyles.titleArea
          }
        >
          {subtask.title}
          {subtask.dueDate && (() => {
            const overdue = isSubtaskOverdue(subtask);
            return (
              <span
                title={`Due ${subtask.dueDate.toLocaleDateString()}${overdue ? " — overdue" : ""}`}
                className={
                  overdue
                    ? `${rowStyles.duePill} ${rowStyles.duePillOverdue}`
                    : rowStyles.duePill
                }
              >
                {overdue ? "Overdue" : `Due ${subtask.dueDate.toLocaleDateString()}`}
              </span>
            );
          })()}
        </span>

        {/* The side-cluster wrapper deliberately does NOT stop event
            propagation: on mobile it wraps to row 2 of the row grid
            (avatars + status pills + tap chevron) and that area should
            still bubble clicks up to the parent `.row` onClick so the
            whole card opens the detail modal. Interactive children
            (+Me / -Me / +Review / -Review / Edit / Delete / matrix
            cells) each carry their own stopPropagation. */}
        <div className={rowStyles.sideCluster}>

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
            membership) forbids the direction they'd move in.

            Phone (<48rem) hides these inline buttons; they re-surface
            full-size inside SubtaskDetailModal's mobile Actions section. */}
        {!isMobile && canSelfAdd && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              selfAddToSubtask(task, subtask.id).catch(console.error);
            }}
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
        {!isMobile && canSelfRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              selfRemoveFromSubtask(task, subtask.id).catch(console.error);
            }}
            style={selfBtn}
            title="Remove me from this subtask"
          >
            − Me
          </button>
        )}
        {!isMobile && canSelfAddReviewer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleSelfAddReviewer().catch(console.error);
            }}
            style={reviewerSelfBtn}
            title={
              blockHasSignoffs
                ? "Add yourself as a reviewer — confirms culture-gate popup since the block is already under review."
                : "Add yourself as a reviewer on this subtask."
            }
          >
            + Review
          </button>
        )}
        {!isMobile && canSelfRemoveReviewer && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleSelfRemoveReviewer().catch(console.error);
            }}
            style={reviewerSelfBtn}
            title={
              blockHasSignoffs
                ? "Admin can still remove themselves post-Notify."
                : "Drop your review scope on this subtask."
            }
          >
            − Review
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
            checkbox IS the approval there, no grid needed.

            Above --bp-md the matrix renders inline in the row. Below
            --bp-md we hide it via `.matrixOnly` and surface a chip
            strip below the row instead (rendered later in the markup
            so DOM order matches reading order). */}
        {showMatrix && reviewers.length > 0 && subtask.roleHint !== "reviewer" && (
          <span
            className={rowStyles.matrixOnly}
            onClick={(e) => e.stopPropagation()}
          >
            <ApprovalMatrixRow
              reviewers={reviewers}
              approvedUids={subtask.approvedByReviewerUids}
              questionedUids={subtask.questionedByReviewerUids}
              rejectedUids={subtask.rejectedByReviewerUids}
              viewerUid={viewerUid}
              approveWillFinalise={approveWillFinalise}
              awaitingCompleterSubmit={!subtask.done}
              viewerFrozenOnBlock={viewerFrozenOnBlock}
              onSet={(state) => {
                handleSetReview(state).catch(console.error);
              }}
            />
          </span>
        )}

        {!isMobile && canEdit && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginLeft: "var(--space-2)" }}
          >
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

        {isMobile &&
          (canSelfAdd ||
            canSelfRemove ||
            canSelfAddReviewer ||
            canSelfRemoveReviewer ||
            canEdit) && (
            <span className={rowStyles.tapChevron} aria-hidden>
              ›
            </span>
          )}

        </div>
      </div>

      {/* Phone replacement for the matrix — read-only chip per reviewer
          coloured by state. Taps open the SubtaskDetailModal where the
          viewer can change their state. */}
      {showMatrix && reviewers.length > 0 && subtask.roleHint !== "reviewer" && (
        <div
          className={`${rowStyles.chipStripOnly} ${rowStyles.chipStrip}`}
          onClick={(e) => e.stopPropagation()}
        >
          {reviewers.map((r) => {
            const approved = subtask.approvedByReviewerUids.includes(r.uid);
            const questioned = subtask.questionedByReviewerUids.includes(r.uid);
            const rejected = subtask.rejectedByReviewerUids.includes(r.uid);
            const chipClass = rejected
              ? `${rowStyles.chip} ${rowStyles.chipRejected}`
              : approved
                ? `${rowStyles.chip} ${rowStyles.chipApproved}`
                : questioned
                  ? `${rowStyles.chip} ${rowStyles.chipQuestion}`
                  : rowStyles.chip;
            const icon = rejected ? "✗" : approved ? "✓" : questioned ? "?" : "—";
            const name = r.displayName ?? r.email ?? r.uid;
            return (
              <button
                key={r.uid}
                type="button"
                className={chipClass}
                onClick={() => setDetailOpen(true)}
                aria-label={`${name} — open subtask to change review state`}
              >
                <span aria-hidden>{icon}</span>
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      )}

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

      {/* Stage 1.9c: composite signoff row — for each reviewer-signoff row,
          show the list of completion subtasks this reviewer is covering
          with their per-subtask decision state icon. Derived from existing
          approval arrays; no schema change. */}
      {subtask.roleHint === "reviewer" && subtask.reviewerUids.length > 0 && (
        <CompositeSignoffItems
          task={task}
          blockId={subtask.blockId}
          reviewerUid={subtask.reviewerUids[0]}
        />
      )}

      {showMatrix && signoffCoverage !== null && signoffCoverage.required > 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            color: "var(--color-text-muted)",
          }}
        >
          {signoffCoverage.approved} / {signoffCoverage.required} approved
        </p>
      )}
      {showMatrix && signoffCoverage === null && approvalStatus.required.length > 0 && (
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
          {approvalStatus.rejected.length > 0 &&
            ` · ${approvalStatus.rejected.length} rejection${approvalStatus.rejected.length === 1 ? "" : "s"}`}
        </p>
      )}

      {/* Resend for review — shown on red (rejected) rows to the people
          who can actually fix it. Wipes reviewer state + emails reviewers. */}
      {approvalStatus.hasRejection &&
        subtask.roleHint !== "reviewer" &&
        (isAdmin || isTaskCreator || isSelfAssigned ||
          (subtask.assigneeUids.length === 0 && isCompleter)) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              paddingTop: "var(--space-1)",
              borderTop: "1px dashed var(--color-danger, #dc2626)",
            }}
          >
            <span
              style={{
                flex: 1,
                fontSize: "var(--text-xs)",
                color: "var(--color-danger, #dc2626)",
                fontWeight: 500,
              }}
            >
              Rejected — fix the issue, then resend for review.
            </span>
            <button
              type="button"
              onClick={handleResubmit}
              disabled={resendBusy}
              style={{
                padding: "0.3rem 0.75rem",
                background: "var(--color-accent-soft)",
                color: "var(--color-accent)",
                border: "none",
                borderRadius: "var(--radius-sm, 4px)",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                cursor: resendBusy ? "not-allowed" : "pointer",
                opacity: resendBusy ? 0.6 : 1,
              }}
            >
              {resendBusy ? "Resending…" : "Resend for review"}
            </button>
          </div>
        )}

      {rejectReasonDraft !== null && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding: "var(--space-3)",
            marginTop: "var(--space-1)",
            background: "var(--color-bg)",
            border: "1px solid var(--color-danger, #dc2626)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-xs)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 700,
              color: "var(--color-danger, #dc2626)",
            }}
          >
            Rejection reason (required)
          </span>
          <textarea
            autoFocus
            value={rejectReasonDraft}
            onChange={(e) => setRejectReasonDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRejectReasonDraft(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitRejection();
            }}
            placeholder="Explain what's wrong so the completer knows what to fix. Sent as a comment + email to the listed assignees."
            rows={3}
            style={{
              width: "100%",
              padding: "var(--space-2)",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: "var(--text-sm)",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setRejectReasonDraft(null)}
              disabled={rejectBusy}
              style={{
                padding: "0.35rem 0.75rem",
                background: "transparent",
                color: "var(--color-text-muted)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm, 4px)",
                fontSize: "var(--text-xs)",
                cursor: rejectBusy ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitRejection}
              disabled={rejectBusy || !rejectReasonDraft.trim()}
              style={{
                padding: "0.35rem 0.85rem",
                background: "var(--color-danger, #dc2626)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-sm, 4px)",
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                cursor:
                  rejectBusy || !rejectReasonDraft.trim() ? "not-allowed" : "pointer",
                opacity: rejectBusy || !rejectReasonDraft.trim() ? 0.55 : 1,
              }}
            >
              {rejectBusy ? "Sending…" : "Reject + notify completers"}
            </button>
          </div>
        </div>
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
              <PersonSelector
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
              <PersonSelector
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

          {/* Block move is a structural edit — gated to admin/creator/committee
              rather than any completer. Previously leaked via the outer
              `canEdit` gate on the edit panel. */}
          {canEditStructure && task.blocks.length > 0 && (
            <div
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
              <ResponsiveSelect
                value={subtask.blockId ?? ""}
                onChange={(next) => {
                  setSubtaskBlock(task, subtask.id, next || null).catch(console.error);
                }}
                options={
                  [
                    { value: "", label: "— Ungrouped —" },
                    ...task.blocks.map((b) => ({
                      value: b.id,
                      label: `${b.name}${b.sealState === "sealed" ? " (sealed)" : ""}`,
                    })),
                  ] satisfies ResponsiveSelectOption[]
                }
                ariaLabel="Block"
              />
            </div>
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
      {detailOpen && (
        <SubtaskDetailModal
          task={task}
          subtask={subtask}
          users={users}
          viewerUid={viewerUid}
          viewerIsAdmin={isAdmin}
          canEditDescription={canEditStructure}
          canEditDueDates={isAdmin || isTaskCreator || isTaskLevelReviewer}
          canComment={
            isAdmin ||
            isTaskCreator ||
            isCompleter ||
            isTaskLevelReviewer ||
            subtask.reviewerUids.includes(viewerUid)
          }
          mobileActions={{
            canSelfAdd,
            onSelfAdd: () => {
              selfAddToSubtask(task, subtask.id).catch(console.error);
            },
            canSelfRemove,
            onSelfRemove: () => {
              selfRemoveFromSubtask(task, subtask.id).catch(console.error);
            },
            canSelfAddReviewer,
            onSelfAddReviewer: () => {
              handleSelfAddReviewer().catch(console.error);
            },
            canSelfRemoveReviewer,
            onSelfRemoveReviewer: () => {
              handleSelfRemoveReviewer().catch(console.error);
            },
            canEdit,
            isEditing: editing,
            onToggleEdit: () => {
              setEditing((v) => !v);
              setDetailOpen(false);
            },
            onDelete: () => {
              handleDelete();
              setDetailOpen(false);
            },
          }}
          onClose={() => setDetailOpen(false)}
        />
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
  const names = users.map((u) => u.displayName ?? u.email ?? u.uid);
  return (
    <HoverTooltip
      content={
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <div
            style={{
              fontSize: "9px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              opacity: 0.6,
            }}
          >
            {title}
          </div>
          {names.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      }
    >
      <span style={{ display: "inline-flex", gap: "2px" }}>
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
    </HoverTooltip>
  );
}

/**
 * Small hover-tooltip helper — shows `content` above `children` after a
 * ~120ms hover delay (short enough to feel responsive, long enough that
 * you don't get a popover on every cursor transit). Positioned absolutely,
 * auto-centred over the trigger; falls back to browser `title` if the user
 * is keyboard-navigating (the content is also reflected via aria-label on
 * trigger).
 */
function HoverTooltip({
  content,
  children,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            padding: "0.4rem 0.6rem",
            background: "var(--color-text)",
            color: "var(--color-bg)",
            border: "1px solid var(--color-border, transparent)",
            borderRadius: "var(--radius-sm, 4px)",
            boxShadow: "var(--shadow-md, 0 2px 6px rgba(0,0,0,0.25))",
            fontSize: "var(--text-xs)",
            lineHeight: 1.3,
            pointerEvents: "none",
            maxWidth: "18rem",
            wordBreak: "break-word",
          }}
        >
          {content}
        </span>
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

/**
 * Composite signoff row content (Stage 1.9c). For a reviewer-signoff
 * subtask, enumerate the completion subtasks in the same block that this
 * reviewer is covering — per effective reviewers (subtask.reviewerUids
 * with fallback to task.reviewerUids). Render each with a state icon so
 * the reviewer can see their whole queue at a glance.
 */
function CompositeSignoffItems({
  task,
  blockId,
  reviewerUid,
}: {
  task: TaskDoc;
  blockId: string | null;
  reviewerUid: string;
}) {
  if (!blockId) return null;
  const covered = task.subtasks.filter((s) => {
    if (s.blockId !== blockId) return false;
    if (s.roleHint === "reviewer") return false;
    const effective = effectiveReviewerUids(s, task.reviewerUids);
    return effective.includes(reviewerUid);
  });
  if (covered.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-xs)",
          color: "var(--color-text-subtle)",
          fontStyle: "italic",
        }}
      >
        No subtasks claimed - use &quot;+ Review&quot; on a completion row to add scope.
      </p>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        marginLeft: "1.75rem",
      }}
    >
      <span
        style={{
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--color-text-muted)",
          fontWeight: 600,
        }}
      >
        Reviewing
      </span>
      {covered.map((s) => {
        const approved = s.approvedByReviewerUids.includes(reviewerUid);
        const questioned = s.questionedByReviewerUids.includes(reviewerUid);
        const rejected = s.rejectedByReviewerUids.includes(reviewerUid);
        const [icon, color] = rejected
          ? ["✗", "var(--color-danger, #dc2626)"]
          : questioned
            ? ["?", "var(--color-warning, var(--color-accent))"]
            : approved
              ? ["✓", "var(--color-success, #16a34a)"]
              : ["⬜", "var(--color-text-subtle)"];
        return (
          <span
            key={s.id}
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--color-text)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "1rem",
                textAlign: "center",
                color,
                fontWeight: 700,
              }}
              aria-hidden="true"
            >
              {icon}
            </span>
            {s.title}
          </span>
        );
      })}
    </div>
  );
}

function ApprovalMatrixRow({
  reviewers,
  approvedUids,
  questionedUids,
  rejectedUids,
  viewerUid,
  approveWillFinalise,
  awaitingCompleterSubmit,
  viewerFrozenOnBlock,
  onSet,
}: {
  reviewers: UserDoc[];
  approvedUids: string[];
  questionedUids: string[];
  rejectedUids: string[];
  viewerUid: string;
  approveWillFinalise: boolean;
  /** True until a completer marks the subtask `done`. Reviewers can't
   *  place approve/question/reject in this state; only `clear` is
   *  allowed (for retracting a stale mark from a previous cycle). */
  awaitingCompleterSubmit: boolean;
  /** The viewer has already ticked their signoff row for this block —
   *  their approvals here are frozen. Other reviewers still act freely. */
  viewerFrozenOnBlock: boolean;
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
            awaitingCompleterSubmit={awaitingCompleterSubmit}
            viewerFrozenOnBlock={isMine && viewerFrozenOnBlock}
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
  awaitingCompleterSubmit,
  viewerFrozenOnBlock,
  onSet,
}: {
  reviewer: UserDoc;
  state: CellState;
  isMine: boolean;
  approveWillFinalise: boolean;
  awaitingCompleterSubmit: boolean;
  viewerFrozenOnBlock: boolean;
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
      <HoverTooltip
        content={
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <div style={{ fontWeight: 600 }}>{label}</div>
            <div style={{ opacity: 0.75 }}>{stateCopy[state]}</div>
          </div>
        }
      >
        <span
          aria-label={`${label} ${state}`}
          style={{ ...sharedCellStyle, cursor: "default" }}
        >
          {icon}
        </span>
      </HoverTooltip>
    );
  }

  const actionsDisabled = awaitingCompleterSubmit || viewerFrozenOnBlock;
  const hintText = viewerFrozenOnBlock
    ? "You've signed off this block — reviews locked. Admin can retract your signoff to unlock."
    : awaitingCompleterSubmit
      ? "Waiting on completer to submit."
      : null;

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          hintText ??
          `Your review — ${state === "empty" ? "click to set" : `currently ${state}`}`
        }
        aria-label={`Set your review state (currently ${state})`}
        style={{
          ...sharedCellStyle,
          borderColor: "var(--color-border)",
          cursor: "pointer",
          padding: 0,
          opacity: actionsDisabled ? 0.55 : 1,
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
          {hintText && (
            <p
              style={{
                margin: 0,
                padding: "0.3rem 0.55rem 0.4rem",
                fontSize: "var(--text-xs)",
                color: "var(--color-text-muted)",
                borderBottom: "1px dashed var(--color-border)",
                marginBottom: "2px",
              }}
            >
              {hintText}
            </p>
          )}
          <ApprovalMenuItem
            icon="✓"
            label={approveWillFinalise ? "Approve (final signoff)" : "Approve"}
            disabled={actionsDisabled}
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
            disabled={actionsDisabled}
            onClick={() => {
              onSet("question");
              setOpen(false);
            }}
            active={state === "question"}
          />
          <ApprovalMenuItem
            icon="✕"
            label="Reject"
            disabled={actionsDisabled}
            onClick={() => {
              onSet("reject");
              setOpen(false);
            }}
            active={state === "rejected"}
          />
          <ApprovalMenuItem
            icon="⬜"
            label="Clear"
            disabled={viewerFrozenOnBlock}
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
  disabled,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0.3rem 0.55rem",
        background: active ? "var(--color-surface-hover)" : "transparent",
        color: disabled ? "var(--color-text-subtle)" : "var(--color-text)",
        border: "none",
        fontSize: "var(--text-sm)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        textAlign: "left",
        borderRadius: "var(--radius-sm, 4px)",
      }}
    >
      <span style={{ width: "1rem", textAlign: "center" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
