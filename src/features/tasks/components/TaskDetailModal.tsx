"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import {
  TASK_FIELD_LIMITS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  canMarkTaskDone,
  getSubtaskApprovalStatus,
  getSubtaskBreakdown,
  type TaskDoc,
  type TaskPriority,
  type TaskStatus,
  type TaskVisibility,
} from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import type { Role } from "@/lib/firebase/session";
import { useTask } from "../hooks/useTask";
import {
  archiveTask,
  deleteTask,
  setTaskStatus,
  setTaskVisibility,
  updateTask,
} from "../taskMutations";
import AssigneePicker from "./AssigneePicker";
import AttachmentList from "./AttachmentList";
import AttachmentUpload from "./AttachmentUpload";
import CommentThread from "./CommentThread";
import DescriptionEditor from "./DescriptionEditor";
import RichTextRender from "./RichTextRender";
import TaskCalendar from "./TaskCalendar";
import SubtaskBreakdown from "./SubtaskBreakdown";
import SubtaskList from "./SubtaskList";
import { useCommentsAndActivity } from "../hooks/useCommentsAndActivity";
import { useTaskAttachments } from "../hooks/useTaskAttachments";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";
import styles from "./TaskDetailModal.module.css";

type Props = {
  taskId: string;
  viewerUid: string;
  viewerRole: Role;
  projects: ProjectDoc[];
  users: UserDoc[];
  /** Optional seed from the parent's `useTasks` cache so the modal renders
   *  the already-known task instantly instead of flashing "Loading task…"
   *  while the first Firestore snapshot arrives. Live edits still stream
   *  through `useTask`'s onSnapshot after mount. */
  initialTask?: TaskDoc | null;
  onClose: () => void;
};

function toDateInputValue(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TaskDetailModal({
  taskId,
  viewerUid,
  viewerRole,
  projects,
  users,
  initialTask,
  onClose,
}: Props) {
  const { task, loading } = useTask(taskId, initialTask);
  const { feed, activity, loading: feedLoading } = useCommentsAndActivity(taskId);
  const isAdmin = viewerRole === "admin";
  const isCommittee = viewerRole === "committee" || viewerRole === "admin";
  const isCompleter = task ? task.completerUids.includes(viewerUid) : false;
  const isTaskReviewer = task ? task.reviewerUids.includes(viewerUid) : false;
  // A viewer is a reviewer if they're on task-level reviewerUids OR on any
  // subtask's per-row reviewerUids. This governs matrix visibility.
  const isAnyReviewer =
    isTaskReviewer ||
    (task?.subtasks.some((s) => s.reviewerUids.includes(viewerUid)) ?? false);
  const isCreator = task ? task.creatorUid === viewerUid : false;
  const canEditAll =
    !!task &&
    (isAdmin ||
      (isCommittee && task.visibility === "committee") ||
      (task.source === "personal" && isCreator));
  // Task-level completer / reviewer rosters are stricter than the broader
  // `canEditAll` — per Phase 3 policy, once a task is created, only admins
  // can reshape its top-level rosters. Committee creators set the roster
  // at creation via TaskForm; post-creation it's locked to admin. Personal
  // tasks stay editable by their creator (who is their only completer).
  const canEditTaskRoster =
    !!task && (isAdmin || (task.source === "personal" && isCreator));
  // Completers and reviewers both can tick subtasks and change status.
  // Reviewers in this band is what lets them tick their review step even if
  // they're not on the completer list.
  const canEditProgressFields = canEditAll || isCompleter || isAnyReviewer;
  // Matrix + reviewer section visibility: admin + creator + any reviewer.
  // Completers who aren't also reviewers see the row state colours only, not
  // the per-reviewer columns or the reviewer picker.
  const canSeeReviewerSection = isAdmin || isCreator || isAnyReviewer;
  // Due dates are owned by whoever set the task up, not the people doing
  // the work. Admin / creator / task-level reviewer can amend; committee-
  // at-large completers cannot. Mirrors the `finalizeBlockSetup` gate from
  // PR #71 — same "task-setter" mental model. Tightened 2026-04-25 after
  // user feedback that completers were able to move dates.
  const canEditDueDates = !!task && (isAdmin || isCreator || isTaskReviewer);
  const now = new Date();

  // Pending sent_for_review — derive from activity so SubtaskRow can tint
  // pending rows orange and the composer can gate its own button. Task-level
  // pending is used for the Done-status disable logic; subtask-level is per-row.
  // pendingTaskReview is computed here too (the helper returns both halves),
  // but right now only pendingSubtaskIds is consumed — for row tinting. The
  // task-level pending is surfaced in the CommentComposer via its own local
  // derivation. Leaving the helper returning both so Phase 3 (which will
  // also disable the Done option while a task-level review is outstanding)
  // doesn't have to refactor.
  const { pendingSubtaskIds } = computePendingReview(activity, task);
  const doneGate = task ? canMarkTaskDone(task) : { ok: false, reason: null };
  // Status = "done" is reviewer/admin/creator-only on tasks with reviewers.
  // Reviewer-less tasks fall back to admin + creator.
  const canMarkDone = task
    ? task.reviewerUids.length > 0
      ? isAdmin || isTaskReviewer || isCreator
      : isAdmin || isCreator
    : false;

  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  // Delete-in-flight state. Declared up here (rather than next to
  // handleDelete) so the Escape handler useEffect below can read it.
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // Stage 5 (2026-04-26) — initial-notification + per-uid notify in-flight
  // sets. Visual hierarchy: the batch button reads as a prominent CTA
  // (one-time send ceremony); the inline Notify pills read as ghost /
  // optional opt-in next to each pending chip.
  const [initialBusy, setInitialBusy] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState<Set<string>>(new Set());
  // Sync drafts when the loaded task changes. Calling setState during render
  // based on a previous-value ref is React's supported pattern for
  // derived-from-props resets (avoids the react-hooks/set-state-in-effect trap
  // that flags synchronous in-effect setState).
  const [syncedId, setSyncedId] = useState<string | null>(null);
  if (task && task.id !== syncedId) {
    setSyncedId(task.id);
    setTitleDraft(task.title);
    setDescDraft(task.description);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't let Escape dismiss the modal while the delete request is in
      // flight — the cascade is already running on the server and the user
      // pressing Escape mid-delete just leaves them staring at a half-gone
      // task on the next page render.
      if (e.key === "Escape" && !deleting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, deleting]);

  const project = task?.projectId ? projects.find((p) => p.id === task.projectId) : null;
  const creator = task ? users.find((u) => u.uid === task.creatorUid) : null;

  // Delete overlay takes precedence over the null-task fallback — once the
  // server finishes deleting the parent doc, the client's `useTask`
  // onSnapshot fires with `task = null`, which would otherwise drop the
  // modal through to "Task not found or you don't have access." mid-request
  // and feel like the page crashed. We stay in the deleting state until the
  // handler resolves and calls onClose().
  if (deleting) {
    return (
      <Overlay onClose={() => {}}>
        <div role="status" className={styles.deletingStatus}>
          <Spinner />
          <div className={styles.deletingLabel}>Deleting task + history…</div>
          <div className={styles.deletingHint}>
            Clearing comments, activity, and attachments. This can take a few
            seconds for tasks with a long history - don&apos;t close the tab.
          </div>
          {deleteErr && <div className={styles.deletingError}>{deleteErr}</div>}
        </div>
      </Overlay>
    );
  }

  if (loading || !task) {
    return (
      <Overlay onClose={onClose}>
        <div className={styles.statusFallback}>
          {loading ? "Loading task…" : "Task not found or you don't have access."}
        </div>
      </Overlay>
    );
  }

  async function saveTitle() {
    if (!task) return;
    const t = titleDraft.trim();
    if (!t || t === task.title) {
      setEditingTitle(false);
      return;
    }
    try {
      await updateTask(task.id, { title: t });
    } catch (err) {
      console.error(err);
    }
    setEditingTitle(false);
  }

  async function saveDesc() {
    if (!task) return;
    if (descDraft.length > TASK_FIELD_LIMITS.description) {
      window.alert(
        `Description is too long (${descDraft.length}/${TASK_FIELD_LIMITS.description}). Trim before saving.`,
      );
      return;
    }
    if (descDraft === task.description) {
      setEditingDesc(false);
      return;
    }
    try {
      await updateTask(task.id, { description: descDraft });
    } catch (err) {
      console.error(err);
    }
    setEditingDesc(false);
  }

  async function onStatusChange(next: TaskStatus) {
    try {
      await setTaskStatus(task!, next);
    } catch (err) {
      console.error(err);
    }
  }

  async function onPriorityChange(next: TaskPriority) {
    try {
      await updateTask(task!.id, { priority: next });
    } catch (err) {
      console.error(err);
    }
  }

  async function onDueChange(value: string) {
    const date = value ? new Date(value) : null;
    try {
      await updateTask(task!.id, { dueDate: date });
    } catch (err) {
      console.error(err);
    }
  }

  async function onProjectChange(value: string) {
    try {
      await updateTask(task!.id, { projectId: value || null });
    } catch (err) {
      console.error(err);
    }
  }

  async function onCompletersChange(uids: string[]) {
    try {
      await updateTask(task!.id, { completerUids: uids });
    } catch (err) {
      console.error(err);
    }
  }

  async function onReviewersChange(uids: string[]) {
    try {
      await updateTask(task!.id, { reviewerUids: uids });
    } catch (err) {
      console.error(err);
    }
  }

  async function onVisibilityChange(v: TaskVisibility) {
    try {
      await setTaskVisibility(task!.id, v);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete() {
    if (!task) return;
    if (
      !window.confirm(
        "Delete this task?\n\nAll comments, activity history, and attachments will be permanently removed. This cannot be undone.",
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteErr(null);
    try {
      const report = await deleteTask(task.id);
      console.info(
        `[deleteTask] removed ${report.comments} comments, ${report.activity} activity entries, ${report.attachments} attachments`,
      );
      onClose();
    } catch (err) {
      console.error(err);
      setDeleteErr(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false); // on success the modal closes; only reset on failure
    }
  }

  async function handleArchiveToggle() {
    if (!task) return;
    try {
      await archiveTask(task.id, !task.archived);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSendInitialNotifications() {
    if (!task || initialBusy) return;
    if (task.initialNotifyAt) return; // one-way
    if (task.completerUids.length === 0 && task.reviewerUids.length === 0) return;
    const memberCount = task.completerUids.length + task.reviewerUids.length;
    const ok = window.confirm(
      `Send membership emails to ${memberCount} member${memberCount === 1 ? "" : "s"}? This is a one-time press — you can't undo it (archive the task to halt further notifications).`,
    );
    if (!ok) return;
    setInitialBusy(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/send-initial-notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Send failed (${res.status})`,
        );
      }
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Send failed");
    } finally {
      setInitialBusy(false);
    }
  }

  async function handleNotifyMember(uid: string) {
    if (!task) return;
    setNotifyBusy((prev) => {
      const next = new Set(prev);
      next.add(uid);
      return next;
    });
    try {
      const res = await fetch(`/api/tasks/${task.id}/notify-member`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Notify failed (${res.status})`,
        );
      }
    } catch (err) {
      console.error(err);
      window.alert(err instanceof Error ? err.message : "Notify failed");
    } finally {
      setNotifyBusy((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className={styles.grid}>
        {/* Main column */}
        <div className={styles.mainColumn}>
          {editingTitle && canEditAll ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setTitleDraft(task.title);
                  setEditingTitle(false);
                }
              }}
              maxLength={TASK_FIELD_LIMITS.title}
              className={styles.titleInput}
            />
          ) : (
            <h2
              onClick={() => canEditAll && setEditingTitle(true)}
              className={canEditAll ? `${styles.title} ${styles.titleEditable}` : styles.title}
            >
              {task.title}
            </h2>
          )}

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>
              <span>Status</span>
              <ResponsiveSelect<TaskStatus>
                value={task.status}
                onChange={onStatusChange}
                options={TASK_STATUSES.map<ResponsiveSelectOption<TaskStatus>>((s) => ({
                  value: s,
                  label: TASK_STATUS_LABELS[s],
                  // Block "done" when (a) viewer isn't eligible, or
                  // (b) the per-subtask + global coverage gates aren't met.
                  // Always allow the current value to render so the picker
                  // doesn't show a phantom option when already "done".
                  disabled:
                    s === "done" &&
                    task.status !== "done" &&
                    (!canMarkDone || !doneGate.ok),
                }))}
                disabled={!canEditProgressFields}
                ariaLabel="Status"
                title={
                  !canMarkDone && task.status !== "done"
                    ? "Only a reviewer, admin, or creator (on reviewer-less tasks) can mark Done"
                    : !doneGate.ok
                      ? (doneGate.reason ?? undefined)
                      : undefined
                }
              />
            </label>
            {canEditAll ? (
              <label className={styles.fieldLabel}>
                <span>Priority</span>
                <ResponsiveSelect<TaskPriority>
                  value={task.priority}
                  onChange={onPriorityChange}
                  options={TASK_PRIORITIES.map<ResponsiveSelectOption<TaskPriority>>((p) => ({
                    value: p,
                    label: TASK_PRIORITY_LABELS[p],
                  }))}
                  ariaLabel="Priority"
                />
              </label>
            ) : (
              <Badge tone="neutral">Priority: {TASK_PRIORITY_LABELS[task.priority]}</Badge>
            )}
          </div>

          {(canEditDueDates || task.dueDate) && (
            <section>
              <h3 className={styles.sectionLabel}>Due date</h3>
              <TaskCalendar
                mode={canEditDueDates ? "edit" : "view"}
                value={task.dueDate}
                isOverdue={
                  task.dueDate !== null &&
                  task.status !== "done" &&
                  task.dueDate.getTime() < now.getTime()
                }
                collapsible
                onChange={(date) =>
                  onDueChange(date ? toDateInputValue(date) : "")
                }
              />
            </section>
          )}

          <section>
            <h3 className={styles.sectionLabel}>Description</h3>
            {editingDesc && canEditAll ? (
              <div className={styles.descEditWrapper}>
                <DescriptionEditor
                  editorKey={`task-desc:${task.id}`}
                  initialBody={task.description}
                  onChange={setDescDraft}
                  autoFocus
                  minHeightRem={6}
                />
                <div className={styles.descEditActions}>
                  <Button size="sm" onClick={saveDesc}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDescDraft(task.description);
                      setEditingDesc(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <span
                    className={
                      descDraft.length > TASK_FIELD_LIMITS.description
                        ? `${styles.charCounter} ${styles.charCounterOver}`
                        : styles.charCounter
                    }
                  >
                    {descDraft.length} / {TASK_FIELD_LIMITS.description}
                  </span>
                </div>
              </div>
            ) : (
              <div
                onClick={() => canEditAll && setEditingDesc(true)}
                className={[
                  styles.descriptionBox,
                  canEditAll ? styles.descriptionBoxEditable : "",
                  task.description ? "" : styles.descriptionBoxEmpty,
                ].filter(Boolean).join(" ")}
              >
                {task.description ? (
                  <RichTextRender body={task.description} />
                ) : canEditAll ? (
                  "Click to add a description…"
                ) : (
                  "No description."
                )}
              </div>
            )}
          </section>

          <section>
            <h3 className={styles.sectionLabel}>Subtasks</h3>
            {task.subtaskStats.total > 0 && (
              <div className={styles.subtaskBreakdownWrapper}>
                <SubtaskBreakdown breakdown={getSubtaskBreakdown(task)} variant="verbose" />
              </div>
            )}
            {canSeeReviewerSection && task.reviewerUids.length > 0 && (
              <ReviewerProgressSummary task={task} users={users} />
            )}
            <SubtaskList
              task={task}
              users={users}
              viewerUid={viewerUid}
              viewerRole={viewerRole}
              canEdit={canEditProgressFields}
              canEditStructure={canEditAll}
              canEditRoster={isAdmin || isCreator}
              showMatrix={canSeeReviewerSection}
              pendingReviewSubtaskIds={pendingSubtaskIds}
            />
          </section>

          <section>
            <h3 className={styles.sectionLabel}>Attachments</h3>
            <AttachmentsSection
              taskId={task.id}
              users={users}
              viewerUid={viewerUid}
              viewerIsAdmin={isAdmin}
              canParticipate={canEditProgressFields}
            />
          </section>

          <section>
            <h3 className={styles.sectionLabel}>Discussion &amp; activity</h3>
            <CommentThread
              task={task}
              users={users}
              viewerUid={viewerUid}
              viewerIsAdmin={isAdmin}
              canParticipate={canEditProgressFields}
              feed={feed}
              activity={activity}
              feedLoading={feedLoading}
            />
          </section>
        </div>

        {/* Sidebar */}
        <div className={styles.sidebar}>
          {canEditAll && (
            <div>
              <h4 className={styles.sectionLabel}>Project</h4>
              <ResponsiveSelect
                value={task.projectId ?? ""}
                onChange={onProjectChange}
                options={
                  [
                    { value: "", label: "— none —" },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ] satisfies ResponsiveSelectOption[]
                }
                ariaLabel="Project"
              />
            </div>
          )}

          {!canEditAll && project && (
            <div>
              <h4 className={styles.sectionLabel}>Project</h4>
              <Badge tone="accent">{project.name}</Badge>
            </div>
          )}

          <div>
            <h4 className={styles.sectionLabel}>Completers</h4>
            {/* Task-level roster edits are admin-only post-creation.
                Committee creators set rosters via TaskForm at creation;
                they can't rewrite them afterwards. Personal-task creators
                retain edit rights on their own tasks. Completer self-
                service for SUBTASK-level membership still works via the
                +Me / −Me buttons on each row. */}
            {canEditTaskRoster ? (
              <AssigneePicker
                users={users}
                selected={task.completerUids}
                onChange={onCompletersChange}
                max={TASK_FIELD_LIMITS.maxCompleters}
                role="completer"
                notifyableUids={canEditTaskRoster ? task.pendingNotifyUids : undefined}
                onNotify={canEditTaskRoster ? handleNotifyMember : undefined}
                notifyBusyUids={Array.from(notifyBusy)}
              />
            ) : (
              <div className={styles.assigneeList}>
                {task.completerUids.length === 0 && (
                  <span className={styles.assigneeListEmpty}>Unassigned</span>
                )}
                {task.completerUids.map((uid) => {
                  const u = users.find((x) => x.uid === uid);
                  return (
                    <span key={uid} className={styles.assigneeListItem}>
                      {u?.displayName ?? u?.email ?? uid}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Reviewer picker + read-only list are hidden from completers
              and non-involved committee. Admin, creator, and anyone who's
              actually a reviewer on this task see it. */}
          {canSeeReviewerSection && (
          <div>
            <h4 className={styles.sectionLabel}>Reviewers</h4>
            {canEditTaskRoster ? (
              <AssigneePicker
                users={users}
                selected={task.reviewerUids}
                onChange={onReviewersChange}
                max={TASK_FIELD_LIMITS.maxReviewers}
                role="reviewer"
                notifyableUids={canEditTaskRoster ? task.pendingNotifyUids : undefined}
                onNotify={canEditTaskRoster ? handleNotifyMember : undefined}
                notifyBusyUids={Array.from(notifyBusy)}
              />
            ) : (
              <div className={styles.assigneeList}>
                {task.reviewerUids.length === 0 && (
                  <span className={styles.assigneeListEmpty}>No reviewer set</span>
                )}
                {task.reviewerUids.map((uid) => {
                  const u = users.find((x) => x.uid === uid);
                  return (
                    <span key={uid} className={styles.assigneeListItem}>
                      {u?.displayName ?? u?.email ?? uid}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Stage 5 (2026-04-26) — "Send initial notifications" CTA, the
              one-time exit from setup phase. Visible only to roster
              editors (admin / personal creator) so committee at large
              don't see a button they can't press. Disabled with a tooltip
              when there are zero members yet so the affordance is
              discoverable but inert. Hidden once initialNotifyAt is
              stamped (one-way transition). */}
          {canEditTaskRoster && task.initialNotifyAt === null && (
            <div>
              {(() => {
                const memberCount =
                  task.completerUids.length + task.reviewerUids.length;
                const disabled = memberCount === 0 || initialBusy;
                return (
                  <Button
                    onClick={handleSendInitialNotifications}
                    disabled={disabled}
                    title={
                      memberCount === 0
                        ? "Add at least one member first."
                        : "Send the membership email to every current completer + reviewer. One-time press."
                    }
                  >
                    {initialBusy
                      ? "Sending…"
                      : memberCount === 0
                        ? "Send initial notifications"
                        : `Send initial notifications (${memberCount})`}
                  </Button>
                );
              })()}
            </div>
          )}
          {canEditTaskRoster && task.initialNotifyAt !== null && (
            <div
              className={styles.initialNotifyConfirmation}
              title={`Initial notifications were sent ${task.initialNotifyAt.toLocaleString()}.`}
            >
              ✓ Initial notifications sent
              {task.pendingNotifyUids.length > 0 &&
                ` · ${task.pendingNotifyUids.length} new member${task.pendingNotifyUids.length === 1 ? "" : "s"} pending`}
            </div>
          )}

          {isAdmin && (
            <div>
              <h4 className={styles.sectionLabel}>Visibility</h4>
              <ResponsiveSelect<TaskVisibility>
                value={task.visibility}
                onChange={onVisibilityChange}
                options={[
                  { value: "committee", label: "Committee-visible" },
                  {
                    value: "assignees-only",
                    label: "Private — assignees + admins",
                  },
                ]}
                ariaLabel="Visibility"
              />
            </div>
          )}

          <div className={styles.meta}>
            <div>
              Created by{" "}
              <strong className={styles.metaName}>
                {creator?.displayName ?? creator?.email ?? "—"}
              </strong>
            </div>
            {task.createdAt && <div>On {task.createdAt.toLocaleDateString()}</div>}
            {task.updatedAt && <div>Updated {task.updatedAt.toLocaleString()}</div>}
            <div className={styles.metaCapitalize}>Source: {task.source.replace("-", " ")}</div>
            <div className={styles.metaCapitalize}>Kind: {task.kind.replace("-", " ")}</div>
          </div>

          {/* Archive + delete are both creator/admin only. Archive is
              reversible (there's an unarchive button) but it removes the
              task from everyone else's default view, so a completer
              archiving a task they're assigned to would feel like it
              disappeared out from under the rest of the team. Matches the
              delete gate for consistency — "big visibility-altering
              actions require elevated privilege". */}
          {(isAdmin || isCreator) && (
            <div className={styles.bottomActions}>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleArchiveToggle}
                disabled={deleting}
              >
                {task.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting task + history…" : "Delete task"}
              </Button>
              {deleteErr && (
                <span role="alert" className={styles.deleteError}>
                  {deleteErr}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * Small local wrapper so the AttachmentList/Upload hook call (useTaskAttachments)
 * is colocated with the section that uses it — keeps the main modal body
 * uncluttered and avoids lifting attachment state higher than needed.
 */
function AttachmentsSection({
  taskId,
  users,
  viewerUid,
  viewerIsAdmin,
  canParticipate,
}: {
  taskId: string;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  canParticipate: boolean;
}) {
  const { attachments } = useTaskAttachments(taskId);
  // Task-level section only shows task-level attachments — subtask-scoped
  // attachments render inside each subtask's detail modal instead.
  // Pre-migration docs have `subtaskId: null` via normalizeAttachment, so
  // they continue to appear here.
  const taskLevel = attachments.filter((a) => a.subtaskId === null);
  // Skip the "Loading attachments…" banner — the list is empty for most
  // tasks, and the few that have attachments will see the rows pop in
  // within ~200ms. Loud banners make the modal feel slow even when the
  // task body already rendered instantly from the parent seed.
  return (
    <div className={styles.attachmentsSection}>
      <AttachmentList
        taskId={taskId}
        attachments={taskLevel}
        users={users}
        viewerUid={viewerUid}
        viewerIsAdmin={viewerIsAdmin}
      />
      {canParticipate && <AttachmentUpload taskId={taskId} />}
    </div>
  );
}

/**
 * Summary strip above the subtask list: "Alice 3/4 ✓ · Bob 2/4 ✓ (1 ?)".
 * Only rendered when the viewer can see the matrix (admin / creator / reviewer).
 */
function ReviewerProgressSummary({
  task,
  users,
}: {
  task: TaskDoc;
  users: UserDoc[];
}) {
  const stats = task.reviewerUids.map((uid) => {
    let approvedCount = 0;
    let questionCount = 0;
    let totalRequired = 0;
    for (const s of task.subtasks) {
      const status = getSubtaskApprovalStatus(s, task.reviewerUids);
      if (!status.required.includes(uid)) continue;
      totalRequired += 1;
      if (status.approved.includes(uid)) approvedCount += 1;
      else if (status.questioned.includes(uid)) questionCount += 1;
    }
    const user = users.find((u) => u.uid === uid);
    const name = user?.displayName ?? user?.email ?? uid;
    return { uid, name, approvedCount, questionCount, totalRequired };
  });
  return (
    <div className={styles.reviewerProgressSummary}>
      {stats.map((s) => {
        const done = s.totalRequired > 0 && s.approvedCount === s.totalRequired;
        const stateClass = done
          ? styles.reviewerStatDone
          : s.questionCount > 0
            ? styles.reviewerStatQuestion
            : styles.reviewerStat;
        return (
          <span key={s.uid} className={stateClass}>
            <strong className={styles.reviewerStatName}>{s.name}</strong>{" "}
            {s.approvedCount}/{s.totalRequired} ✓
            {s.questionCount > 0 && ` (${s.questionCount} ?)`}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Walk the activity stream to find the latest `sent_for_review` per target
 * (subtask id, or null for task-level). A target is considered "pending"
 * until its resolution event — subtask done, or task status = done.
 */
function computePendingReview(
  activity: ActivityDoc[],
  task: TaskDoc | null,
): { pendingTaskReview: boolean; pendingSubtaskIds: Set<string> } {
  if (!task) return { pendingTaskReview: false, pendingSubtaskIds: new Set() };
  let latestTask: ActivityDoc | null = null;
  const latestBySubtask = new Map<string, ActivityDoc>();
  for (const a of activity) {
    if (a.kind !== "sent_for_review") continue;
    const subId =
      typeof a.payload?.subtaskId === "string" ? (a.payload.subtaskId as string) : null;
    if (subId === null) {
      if (!latestTask || (a.createdAt?.getTime() ?? 0) > (latestTask.createdAt?.getTime() ?? 0)) {
        latestTask = a;
      }
    } else {
      const prev = latestBySubtask.get(subId);
      if (!prev || (a.createdAt?.getTime() ?? 0) > (prev.createdAt?.getTime() ?? 0)) {
        latestBySubtask.set(subId, a);
      }
    }
  }
  const pendingTaskReview = Boolean(latestTask && task.status !== "done");
  const pendingSubtaskIds = new Set<string>();
  for (const [subId] of latestBySubtask) {
    const sub = task.subtasks.find((s) => s.id === subId);
    if (sub && !sub.done) pendingSubtaskIds.add(subId);
  }
  return { pendingTaskReview, pendingSubtaskIds };
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className={styles.overlay}
    >
      <div onClick={(e) => e.stopPropagation()} className={styles.panel}>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={styles.closeButton}
        >
          ✕
        </button>
        {children}
      </div>
    </div>
  );
}

/**
 * Small spinning ring, used in the "Deleting…" overlay. SMIL-animated so we
 * don't need a CSS keyframe block in this file (the codebase doesn't set up
 * a shared `@keyframes spin` and inline `<style>` tags render oddly inside
 * portalled modals).
 */
function Spinner() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={styles.spinner}
    >
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="var(--color-border)"
        strokeWidth="3"
      />
      <path
        d="M16 4 A12 12 0 0 1 28 16"
        fill="none"
        stroke="var(--color-accent, var(--color-text))"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 16 16"
          to="360 16 16"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}
