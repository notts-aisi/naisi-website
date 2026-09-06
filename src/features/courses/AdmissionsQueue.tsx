"use client";

import { useMemo, useState, type ReactNode } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import { Textarea } from "@/components/ui/Input";
import { useClientPagination } from "@/features/admin/adminList";
import {
  APPLICATION_FIELD_LIMITS,
  COURSE_APPLICATION_STATUS_LABEL,
  type CourseApplicationStatus,
} from "@/lib/firestore/courseApplications";
import {
  useRunApplications,
  type AdmissionsGroup,
  type AdmissionsRow,
} from "./useRunApplications";
import styles from "./AdmissionsQueue.module.css";

/**
 * The admissions review queue for one course run. Mounted twice, deliberately
 * from the SAME component: `/learn/[runId]/admissions` for assigned reviewers
 * and `/admin/courses/[courseId]/runs/[runId]/applications` for admins.
 *
 * The only difference between the two is the `isAdmin` prop and what the server
 * chose to put in the payload. That is the whole design:
 *
 *  - **Admissions is not facilitation.** Reviewing applications grants no sight
 *    of the cohort, and this component never links into one. A reviewer's
 *    entire course surface is this page.
 *  - **Deciding does not enrol anybody.** Accept/waitlist/reject move a status
 *    and send a lifecycle email. Placing people into groups is a separate,
 *    later step, which is why the reviewer records a *preference* here rather
 *    than a placement.
 *  - **Non-admin reviewers must never receive applicant email addresses.** The
 *    route sends `email: null` to them; `isAdmin` only decides whether to
 *    render an address that is already present. There is no other source of an
 *    address on this surface — no users read, no mailto built from a uid — so
 *    a reviewer who tampers with the prop still has nothing to reveal.
 *  - **The paid-membership tag is a badge, never a gate.** It sits beside the
 *    name and branches nothing, here or in the route.
 *
 * Member-authored content (answers, availability, notes) is rendered as TEXT
 * NODES only. No `dangerouslySetInnerHTML` anywhere in this file, by rule.
 */

type Props = {
  runId: string;
  /** Admins additionally see applicant email addresses. Nothing else changes. */
  isAdmin: boolean;
};

type DecisionAction = "accept" | "waitlist" | "reject";

const STATUS_BADGE: Record<
  CourseApplicationStatus,
  { tone: "neutral" | "accent" | "success" | "danger" | "warning" }
> = {
  pending: { tone: "accent" },
  accepted: { tone: "success" },
  waitlisted: { tone: "warning" },
  rejected: { tone: "danger" },
  withdrawn: { tone: "neutral" },
};

const DECISION_COPY: Record<DecisionAction, { saving: string; success: string }> = {
  accept: { saving: "Accepting…", success: "Accepted — they'll get an email" },
  waitlist: { saving: "Waitlisting…", success: "Waitlisted — they'll get an email" },
  reject: { saving: "Recording decision…", success: "Decision recorded" },
};

/**
 * Form-question ids are opaque (`newQuestionId()` → `q_<base36>_<rand>`), and
 * the review payload carries answers keyed by id without the run's question
 * labels. Rather than print machine ids at a reviewer, an opaque key falls back
 * to its position ("Question 2"); a hand-authored, readable key is shown as-is.
 * When the route does send labels (optional `run.questions`) they win.
 */
const OPAQUE_QUESTION_ID = /^q_[a-z0-9]+_[a-z0-9]+$/;

/**
 * One stored answer as plain text. Defensive by design: `answers` is typed
 * `Record<string, unknown>` because it is member-authored data that has been
 * through a JSON round trip, so every branch checks before it reads.
 */
function answerToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string").join(", ");
  }
  if (typeof value === "object") {
    const obj = value as { checked?: unknown; other?: unknown };
    const parts: string[] = [];
    if (Array.isArray(obj.checked)) {
      parts.push(...obj.checked.filter((v): v is string => typeof v === "string"));
    }
    if (typeof obj.other === "string" && obj.other) parts.push(`Other: ${obj.other}`);
    return parts.join(", ");
  }
  return "";
}

function answerRows(
  answers: Record<string, unknown>,
  labels: Map<string, string>,
): { key: string; label: string; value: string }[] {
  return Object.keys(answers)
    .map((key, index) => ({
      key,
      label:
        labels.get(key) ??
        (OPAQUE_QUESTION_ID.test(key) ? `Question ${index + 1}` : key),
      value: answerToText(answers[key]),
    }))
    .filter((row) => row.value !== "");
}

/** Client-only render (data arrives from a fetch), so no SSR/CSR skew. */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdmissionsQueue({ runId, isAdmin }: Props) {
  const { data, loading, error, reload } = useRunApplications(runId);
  const { toast, run: runAction, dismiss } = useActionToast();
  const [busyUid, setBusyUid] = useState<string | null>(null);

  // Both memoised on `data` rather than read inline: the `?? []` fallback would
  // otherwise mint a fresh array every render and rebuild every list below it.
  const applications = useMemo(() => data?.applications ?? [], [data]);
  const groups = useMemo(() => data?.groups ?? [], [data]);

  // Oldest first in the queue — the person who has been waiting longest is the
  // one to read next. Decided rows go newest-decision first, because that list
  // is consulted to check what was just done, not worked through.
  const pending = useMemo(
    () =>
      applications
        .filter((a) => a.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [applications],
  );
  const decided = useMemo(
    () =>
      applications
        .filter((a) => a.status !== "pending")
        .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "")),
    [applications],
  );

  /**
   * Every facilitator name the payload knows about, keyed by uid. This is the
   * ONLY name source on this surface — the queue never reads the users
   * collection, so a reviewer can't enumerate members through it.
   */
  const facilitatorPool = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      for (const person of group.facilitators) {
        if (!map.has(person.uid)) map.set(person.uid, person.displayName);
      }
    }
    return map;
  }, [groups]);

  const questionLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of data?.run.questions ?? []) map.set(q.id, q.label);
    return map;
  }, [data]);

  /**
   * One mutation, one toast, one settle. `useActionToast().run` never rethrows
   * — it turns the error into the toast — so the outcome comes back on a box
   * rather than a captured `let` (TypeScript can't narrow across the closure).
   */
  async function call(
    uid: string,
    url: string,
    init: RequestInit,
    copy: { saving: string; success: string },
  ) {
    const outcome = { ok: false };
    setBusyUid(uid);
    try {
      await runAction(
        async () => {
          const res = await fetch(url, init);
          const body = (await res.json().catch(() => null)) as
            | { ok?: true; error?: string }
            | null;
          // Surface the route's own sentence: "Applications are closed" and
          // "You are no longer a reviewer on this run" need different reactions.
          if (!res.ok || !body?.ok) {
            throw new Error(body?.error ?? `That didn't go through (${res.status}).`);
          }
          outcome.ok = true;
        },
        { savingMessage: copy.saving, successMessage: copy.success },
      );
    } finally {
      setBusyUid(null);
    }
    // Re-read rather than patch local state: `status`, `decidedAt` and the
    // run's counters are all server-owned, and the queue should show what
    // admissions actually holds.
    if (outcome.ok) reload();
  }

  function decide(row: AdmissionsRow, action: DecisionAction, reason?: string) {
    const body = reason ? { action, reason } : { action };
    return call(
      row.uid,
      `/api/courses/runs/${encodeURIComponent(runId)}/applications/${encodeURIComponent(row.uid)}/decide`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      DECISION_COPY[action],
    );
  }

  function saveNotes(row: AdmissionsRow, patch: NotesPatch) {
    return call(
      row.uid,
      `/api/courses/runs/${encodeURIComponent(runId)}/applications/${encodeURIComponent(row.uid)}/notes`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
      { saving: "Saving notes…", success: "Notes saved" },
    );
  }

  // A failed FIRST load has nothing to fall back to. A failed refresh does:
  // keeping the last good queue on screen beats replacing a reviewer's work in
  // progress with an error card, so that case is a banner further down.
  if (error && !data) {
    return (
      <Card padding="lg">
        <p className={styles.error}>Couldn&apos;t load applications: {error.message}</p>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {loading ? "Retrying…" : "Try again"}
          </Button>
        </div>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card padding="lg">
        <p className={styles.muted}>Loading applications…</p>
      </Card>
    );
  }

  const { run } = data;
  const counts = run.applicationCounts;

  const renderCard = (row: AdmissionsRow) => (
    <ApplicationCard
      key={row.uid}
      row={row}
      groups={groups}
      facilitatorPool={facilitatorPool}
      questionLabels={questionLabels}
      academicYear={run.academicYear}
      isAdmin={isAdmin}
      busy={busyUid === row.uid}
      onDecide={decide}
      onSaveNotes={saveNotes}
    />
  );

  return (
    <>
      <div className={styles.queue}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{run.courseTitle || "Course"}</p>
            <h2 className={styles.title}>{run.label || "Untitled run"}</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </header>

        <div className={styles.counts}>
          <Stat label="Pending" value={counts.pending} />
          <Stat label="Accepted" value={counts.accepted} />
          <Stat label="Waitlisted" value={counts.waitlisted} />
          <Stat label="Rejected" value={counts.rejected} />
          <Stat label="Withdrawn" value={counts.withdrawn} />
        </div>

        <p className={styles.lede}>
          Accepting someone records a decision and emails them — it does not put
          them in a group. Places are allocated separately, which is what the
          group and facilitator preferences below are for.
        </p>

        {error && (
          <p className={styles.error} role="status">
            Couldn&apos;t refresh: {error.message} — showing the last version
            that loaded.
          </p>
        )}

        {applications.length === 0 ? (
          <Card padding="lg">
            <h3 className={styles.emptyTitle}>No applications yet</h3>
            <p className={styles.muted}>
              Once applications open for this run, everyone who applies appears
              here for review.
            </p>
          </Card>
        ) : (
          <>
            <QueueSection
              heading="Pending review"
              rows={pending}
              noun="applications"
              emptyText="Nothing waiting for review."
              renderRow={renderCard}
            />
            {decided.length > 0 && (
              <QueueSection
                heading="Decided"
                rows={decided}
                noun="applications"
                emptyText="No decisions yet."
                renderRow={renderCard}
              />
            )}
          </>
        )}
      </div>
      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </span>
  );
}

/**
 * A titled block of application cards. The whole payload is already in memory,
 * so paging is purely about not dumping hundreds of expanded cards into the
 * document at once — `useClientPagination`, the admin-list idiom. Each section
 * pages independently: a long decided list must never push the pending queue
 * (the actual work) below a "show more".
 */
function QueueSection({
  heading,
  rows,
  noun,
  emptyText,
  renderRow,
}: {
  heading: string;
  rows: AdmissionsRow[];
  noun: string;
  emptyText: string;
  renderRow: (row: AdmissionsRow) => ReactNode;
}) {
  const { shown, hasMore, loadMore, total, shownCount } = useClientPagination(rows, 20);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {heading} <span className={styles.sectionCount}>{total}</span>
      </h3>
      {total === 0 ? (
        <p className={styles.muted}>{emptyText}</p>
      ) : (
        <>
          <div className={styles.rows}>{shown.map(renderRow)}</div>
          {hasMore && (
            <div className={styles.more}>
              <span className={styles.muted}>
                Showing {shownCount} of {total} {noun}
              </span>
              <Button variant="ghost" size="sm" onClick={loadMore}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type NotesPatch = {
  reviewerNotes: string;
  reviewerPreferredGroupId: string | null;
  reviewerPreferredFacilitatorUid: string | null;
};

/**
 * Signature of the reviewer-owned fields, joined on a separator that cannot
 * appear inside a group id or a uid. Deliberately EXCLUDES `status`: a decision
 * refetches the row, and resyncing the editors off that would throw away notes
 * the reviewer had typed but not yet saved.
 */
function reviewerSignature(row: AdmissionsRow): string {
  return [
    row.reviewerNotes ?? "",
    row.reviewerPreferredGroupId ?? "",
    row.reviewerPreferredFacilitatorUid ?? "",
  ].join("\n\u2063\n");
}

function ApplicationCard({
  row,
  groups,
  facilitatorPool,
  questionLabels,
  academicYear,
  isAdmin,
  busy,
  onDecide,
  onSaveNotes,
}: {
  row: AdmissionsRow;
  groups: AdmissionsGroup[];
  facilitatorPool: Map<string, string>;
  questionLabels: Map<string, string>;
  academicYear: string;
  isAdmin: boolean;
  busy: boolean;
  onDecide: (row: AdmissionsRow, action: DecisionAction, reason?: string) => void;
  onSaveNotes: (row: AdmissionsRow, patch: NotesPatch) => void;
}) {
  const [notes, setNotes] = useState(row.reviewerNotes ?? "");
  const [groupId, setGroupId] = useState(row.reviewerPreferredGroupId ?? "");
  const [facilitatorUid, setFacilitatorUid] = useState(
    row.reviewerPreferredFacilitatorUid ?? "",
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(row.decisionReason ?? "");

  /**
   * Adjust-state-on-prop-change (React's documented pattern — no effect, no
   * flash), split into two because the two halves answer to different events.
   *
   * The reviewer fields resync when the SERVER's copy of them moves: our own
   * save comes back identical (invisible), and a save by another reviewer wins
   * rather than being silently clobbered by the next save from this card.
   */
  const signature = reviewerSignature(row);
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    setNotes(row.reviewerNotes ?? "");
    setGroupId(row.reviewerPreferredGroupId ?? "");
    setFacilitatorUid(row.reviewerPreferredFacilitatorUid ?? "");
  }

  // The reject editor answers to the STATUS instead: once a decision lands, the
  // reason box has done its job and the normal action row should be back
  // without a manual refresh (the CollaboratorCard precedent). Keeping this
  // separate is what stops a decision from also wiping unsaved notes.
  const [lastStatus, setLastStatus] = useState(row.status);
  if (row.status !== lastStatus) {
    setLastStatus(row.status);
    setRejecting(false);
    setReason(row.decisionReason ?? "");
  }

  // Withdrawn is the applicant's own decision. Nothing here may overwrite it —
  // no decision buttons, no reviewer edits.
  const readOnly = row.status === "withdrawn";

  const groupOptions: ResponsiveSelectOption[] = [
    { value: "", label: "No preferred group" },
    ...groups.map((g) => ({
      value: g.id,
      label: g.sessionLabel ? `${g.name} — ${g.sessionLabel}` : g.name,
    })),
  ];
  // A group that has since been deleted would otherwise vanish from the select
  // and read as "no preference", quietly discarding a recorded decision.
  if (groupId && !groups.some((g) => g.id === groupId)) {
    groupOptions.push({ value: groupId, label: "Group no longer exists" });
  }

  // "The selected group's facilitators ∪ the run's facilitator pool" — the
  // group's own people first, because that is the likely pick, but the rest
  // stay offered: a preference is a suggestion for allocation, not a placement.
  const selectedGroup = groups.find((g) => g.id === groupId);
  const groupFacilitators = selectedGroup?.facilitators ?? [];
  const inGroup = new Set(groupFacilitators.map((f) => f.uid));
  const others = Array.from(facilitatorPool.entries())
    .filter(([uid]) => !inGroup.has(uid))
    .map(([uid, displayName]) => ({ uid, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const facilitatorOptions: ResponsiveSelectOption[] = [
    { value: "", label: "No preferred facilitator" },
    ...groupFacilitators.map((f) => ({ value: f.uid, label: f.displayName })),
    ...others.map((f) => ({ value: f.uid, label: f.displayName })),
  ];
  if (facilitatorUid && !facilitatorPool.has(facilitatorUid)) {
    facilitatorOptions.push({
      value: facilitatorUid,
      label: "No longer a facilitator here",
    });
  }

  const answers = answerRows(row.answers, questionLabels);
  const notesId = `admissions-notes-${row.uid}`;
  const reasonId = `admissions-reason-${row.uid}`;
  const paidLabel = academicYear ? `Paid ${academicYear}` : "Paid member";
  // Nothing to send when nothing moved — and a Save button that reads "Notes
  // saved" is a clearer answer to "did that go through?" than a live button.
  const dirty =
    notes !== (row.reviewerNotes ?? "") ||
    groupId !== (row.reviewerPreferredGroupId ?? "") ||
    facilitatorUid !== (row.reviewerPreferredFacilitatorUid ?? "");

  return (
    <Card padding="lg" className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.identity}>
          <h4 className={styles.name}>{row.displayName || "Applicant"}</h4>
          <div className={styles.identityBadges}>
            {/* A badge for context at review. It gates nothing, here or in the
                route — a run does not require paid membership. */}
            <Badge tone={row.paidMembership ? "success" : "warning"}>
              {row.paidMembership ? paidLabel : "Unpaid"}
            </Badge>
          </div>
          {/* Admins only. Non-admin reviewers get `email: null` from the route,
              so there is nothing to render even if this branch were forced. */}
          {isAdmin && row.email ? (
            <a className={styles.email} href={`mailto:${row.email}`}>
              {row.email}
            </a>
          ) : null}
          {row.createdAt ? (
            <p className={styles.timestamp}>Applied {formatWhen(row.createdAt)}</p>
          ) : null}
        </div>
        <Badge tone={STATUS_BADGE[row.status].tone}>
          {COURSE_APPLICATION_STATUS_LABEL[row.status]}
        </Badge>
      </div>

      {row.availability.length > 0 ? (
        <div className={styles.block}>
          <p className={styles.blockLabel}>Times they can make</p>
          <ul className={styles.chips}>
            {row.availability.map((slot) => (
              <li key={slot} className={styles.chip}>
                {slot}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {answers.length > 0 ? (
        <dl className={styles.answers}>
          {answers.map((answer) => (
            <div key={answer.key} className={styles.answerRow}>
              <dt className={styles.answerLabel}>{answer.label}</dt>
              {/* Member-authored: a text node, never markup. */}
              <dd className={styles.answerValue}>{answer.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.muted}>No answers submitted.</p>
      )}

      {row.decidedAt || row.decidedByName || row.decisionReason ? (
        <p className={styles.decision}>
          {COURSE_APPLICATION_STATUS_LABEL[row.status]}
          {row.decidedByName ? ` by ${row.decidedByName}` : ""}
          {row.decidedAt ? ` · ${formatWhen(row.decidedAt)}` : ""}
          {row.decisionReason ? (
            <span className={styles.decisionReason}>{row.decisionReason}</span>
          ) : null}
        </p>
      ) : null}

      {readOnly ? (
        <>
          {row.reviewerNotes ? (
            <div className={styles.block}>
              <p className={styles.blockLabel}>Reviewer notes</p>
              <p className={styles.answerValue}>{row.reviewerNotes}</p>
            </div>
          ) : null}
          <p className={styles.muted}>
            This application was withdrawn by the applicant, so it is read-only.
          </p>
        </>
      ) : (
        <>
          <div className={styles.tools}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={notesId}>
                Reviewer notes
              </label>
              <p className={styles.hint}>
                Only reviewers and admins see these. The applicant never does.
              </p>
              <CountedTextarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                max={APPLICATION_FIELD_LIMITS.reviewerNotes}
                rows={3}
                disabled={busy}
                placeholder="What stood out, what to check, anything the allocation step should know."
              />
            </div>

            <div className={styles.preferences}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Preferred group</span>
                <ResponsiveSelect
                  value={groupId}
                  onChange={setGroupId}
                  options={groupOptions}
                  disabled={busy}
                  ariaLabel={`Preferred group for ${row.displayName || "this applicant"}`}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Preferred facilitator</span>
                <ResponsiveSelect
                  value={facilitatorUid}
                  onChange={setFacilitatorUid}
                  options={facilitatorOptions}
                  disabled={busy}
                  ariaLabel={`Preferred facilitator for ${row.displayName || "this applicant"}`}
                />
              </div>
            </div>
            <p className={styles.hint}>
              A suggestion for whoever allocates places — applicants never pick
              either of these, and saving one places nobody.
            </p>

            <div className={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !dirty}
                onClick={() =>
                  onSaveNotes(row, {
                    reviewerNotes: notes,
                    reviewerPreferredGroupId: groupId || null,
                    reviewerPreferredFacilitatorUid: facilitatorUid || null,
                  })
                }
              >
                {dirty ? "Save notes" : "Notes saved"}
              </Button>
            </div>
          </div>

          {rejecting ? (
            <div className={styles.rejectBox}>
              <label className={styles.fieldLabel} htmlFor={reasonId}>
                Reason (optional — included in their email)
              </label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={APPLICATION_FIELD_LIMITS.decidedReason}
                disabled={busy}
                placeholder="Kept short and kind — they will read this."
              />
              <div className={styles.actions}>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(row, "reject", reason.trim())}
                >
                  Confirm rejection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* A decided row keeps the buttons for the OTHER outcomes so a
               decision can be changed, and hides its own — the collaborators
               precedent. */
            <div className={styles.actions}>
              {row.status !== "accepted" && (
                <Button size="sm" disabled={busy} onClick={() => onDecide(row, "accept")}>
                  Accept
                </Button>
              )}
              {row.status !== "waitlisted" && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(row, "waitlist")}
                >
                  Waitlist
                </Button>
              )}
              {row.status !== "rejected" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                >
                  Reject
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
