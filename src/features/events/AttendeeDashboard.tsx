"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { copyToClipboard, downloadCSV, toCSV } from "@/lib/csv";
import {
  FOOD_PROVENANCE_BADGE,
  RSVP_STATUS_LABEL,
  RSVP_STATUSES,
  type EventDoc,
  type FormQuestion,
  type RsvpAnswer,
  type RsvpDoc,
  type RsvpStatus,
} from "@/lib/firestore/events";
import { useEventRsvps } from "./useEventRsvps";
import OrderHelper from "./OrderHelper";
import Pie, { pickColor, type PieSlice } from "./Pie";
import styles from "./AttendeeDashboard.module.css";

type Props = { event: EventDoc };

function statusTone(
  status: RsvpStatus,
): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "pending":
      return "warning";
    case "confirmed":
      return "success";
    case "waitlisted":
      return "accent";
    case "denied":
      return "danger";
    case "cancelled":
      return "neutral";
  }
}

/** Stringify a raw answer for CSV / table display. */
function renderAnswer(a: RsvpAnswer | undefined): string {
  if (a === undefined || a === null) return "";
  if (typeof a === "string") return a;
  if (typeof a === "boolean") return a ? "Yes" : "No";
  if (Array.isArray(a)) return a.join(", ");
  if (typeof a === "object") {
    const obj = a as { checked?: string[]; other?: string };
    const parts: string[] = [];
    if (Array.isArray(obj.checked) && obj.checked.length > 0) parts.push(...obj.checked);
    if (obj.other) parts.push(`Other: ${obj.other}`);
    return parts.join(", ");
  }
  return "";
}

export default function AttendeeDashboard({ event }: Props) {
  const { rsvps, loading, error } = useEventRsvps(event.id);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyNote, setDenyNote] = useState("");
  const [filter, setFilter] = useState<"active" | RsvpStatus | "all">("active");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastSubject, setBroadcastSubject] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastIncludeWaitlist, setBroadcastIncludeWaitlist] = useState(true);
  const [broadcastState, setBroadcastState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; sent: number; failed: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const pending = useMemo(() => rsvps.filter((r) => r.status === "pending"), [rsvps]);
  const confirmed = useMemo(() => rsvps.filter((r) => r.status === "confirmed"), [rsvps]);
  const waitlisted = useMemo(() => rsvps.filter((r) => r.status === "waitlisted"), [rsvps]);
  const denied = useMemo(() => rsvps.filter((r) => r.status === "denied"), [rsvps]);
  const cancelled = useMemo(() => rsvps.filter((r) => r.status === "cancelled"), [rsvps]);
  const pendingChanges = useMemo(
    () => rsvps.filter((r) => r.pendingAnswers),
    [rsvps],
  );

  // "active" = counts that matter for catering/ordering (confirmed + waitlisted).
  // Pies and counts default to this slice so the food order number is obvious.
  const active = useMemo(
    () => rsvps.filter((r) => r.status === "confirmed" || r.status === "waitlisted"),
    [rsvps],
  );

  const visibleRows = useMemo(() => {
    if (filter === "all") return rsvps;
    if (filter === "active") return active;
    return rsvps.filter((r) => r.status === filter);
  }, [rsvps, filter, active]);

  async function act(
    rsvpId: string,
    path: "approve" | "deny" | "cancel" | "approve-change" | "deny-change",
    note?: string,
  ) {
    setBusyId(rsvpId);
    setActionErr(null);
    try {
      const res = await fetch(`/api/events/${event.id}/rsvp/${rsvpId}/${path}`, {
        method: "POST",
        headers: note !== undefined ? { "content-type": "application/json" } : {},
        body: note !== undefined ? JSON.stringify({ note }) : undefined,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setActionErr(body?.error ?? `Action failed (${res.status})`);
      }
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onApprove(r: RsvpDoc) {
    await act(r.id, "approve");
  }

  async function onDenyConfirm() {
    if (!denyFor) return;
    await act(denyFor, "deny", denyNote);
    setDenyFor(null);
    setDenyNote("");
  }

  async function onCancel(r: RsvpDoc) {
    if (!window.confirm(`Cancel RSVP from ${r.name}? They'll need to re-submit.`)) return;
    await act(r.id, "cancel");
  }

  async function onApproveChange(r: RsvpDoc) {
    await act(r.id, "approve-change");
  }

  async function onDenyChange(r: RsvpDoc) {
    if (
      !window.confirm(
        `Reject ${r.name}'s change request? Their original answers will stay in place.`,
      )
    )
      return;
    await act(r.id, "deny-change");
  }

  async function onSendBroadcast(e: React.FormEvent) {
    e.preventDefault();
    if (!broadcastSubject.trim() || !broadcastBody.trim()) {
      setBroadcastState({
        kind: "error",
        message: "Both subject and message body are required.",
      });
      return;
    }
    const recipientCount =
      confirmed.length + (broadcastIncludeWaitlist ? waitlisted.length : 0);
    if (recipientCount === 0) {
      setBroadcastState({
        kind: "error",
        message: "No active RSVPs to email.",
      });
      return;
    }
    if (
      !window.confirm(
        `Send this update to ${recipientCount} attendee${recipientCount === 1 ? "" : "s"}?`,
      )
    )
      return;
    setBroadcastState({ kind: "sending" });
    try {
      const res = await fetch(`/api/events/${event.id}/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: broadcastSubject,
          body: broadcastBody,
          includeWaitlisted: broadcastIncludeWaitlist,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; sent?: number; failed?: number; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setBroadcastState({
          kind: "error",
          message: body?.error ?? `Send failed (${res.status})`,
        });
        return;
      }
      setBroadcastState({
        kind: "sent",
        sent: body.sent ?? 0,
        failed: body.failed ?? 0,
      });
      setBroadcastSubject("");
      setBroadcastBody("");
    } catch (err) {
      setBroadcastState({
        kind: "error",
        message: err instanceof Error ? err.message : "Send failed",
      });
    }
  }

  async function onCopyEmails() {
    const emails = Array.from(new Set(active.map((r) => r.email))).join(", ");
    if (!emails) {
      setCopyStatus("No active RSVPs to copy.");
      setTimeout(() => setCopyStatus(null), 3000);
      return;
    }
    const ok = await copyToClipboard(emails);
    setCopyStatus(ok ? `Copied ${active.length} email(s).` : "Copy failed.");
    setTimeout(() => setCopyStatus(null), 3000);
  }

  function onDownloadCSV() {
    const questions = event.signupForm;
    const header = [
      "name",
      "email",
      "status",
      "createdAt",
      ...questions.map((q) => q.label || q.id),
    ];
    const rows = rsvps.map((r) => [
      r.name,
      r.email,
      r.status,
      r.createdAt?.toISOString() ?? "",
      ...questions.map((q) => renderAnswer(r.answers[q.id])),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    const safeTitle = event.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) || "event";
    downloadCSV(`${safeTitle}-rsvps-${stamp}.csv`, toCSV(header, rows));
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading RSVPs…</p>
      </Card>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load RSVPs: {error.message}
        </p>
      </Card>
    );
  }

  const capacityLine =
    event.capacity !== null
      ? `${confirmed.length} confirmed / ${event.capacity} capacity`
      : `${confirmed.length} confirmed (unlimited capacity)`;

  return (
    <div className={styles.wrap}>
      {/* Summary strip --------------------------------------------------- */}
      <Card padding="lg">
        <div className={styles.counts}>
          <CountBox label="Pending" value={pending.length} tone="warning" />
          <CountBox label="Confirmed" value={confirmed.length} tone="success" />
          <CountBox label="Waitlisted" value={waitlisted.length} tone="accent" />
          <CountBox label="Denied" value={denied.length} tone="danger" />
          <CountBox label="Cancelled" value={cancelled.length} tone="neutral" />
        </div>
        <p className={styles.capacityLine}>
          {capacityLine}
          {event.foodProvenance !== "none" && (
            <>
              {" · "}
              <Badge tone="accent">{FOOD_PROVENANCE_BADGE[event.foodProvenance]}</Badge>
            </>
          )}
        </p>
      </Card>

      {/* Broadcast composer --------------------------------------------- */}
      <section>
        <div className={styles.tableHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Send an update</h2>
            <p className={styles.sectionHint}>
              One-click email to every confirmed (and optionally waitlisted) attendee —
              use for room changes, reminders, weather calls.
            </p>
          </div>
          {!broadcastOpen && (
            <Button variant="ghost" onClick={() => setBroadcastOpen(true)}>
              Compose update
            </Button>
          )}
        </div>
        {broadcastOpen && (
          <Card padding="lg">
            <form
              onSubmit={onSendBroadcast}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            >
              <Field
                id="broadcast-subject"
                label="Subject"
                hint="The event title is appended automatically."
              >
                <Input
                  id="broadcast-subject"
                  value={broadcastSubject}
                  onChange={(e) => setBroadcastSubject(e.target.value)}
                  disabled={broadcastState.kind === "sending"}
                  maxLength={150}
                  placeholder="e.g. Room change — moved to Pope B11"
                />
              </Field>
              <Field
                id="broadcast-body"
                label="Message"
                hint="Plain text. Blank lines create paragraphs. Attendees always see the when/where at the bottom."
              >
                <textarea
                  id="broadcast-body"
                  value={broadcastBody}
                  onChange={(e) => setBroadcastBody(e.target.value)}
                  disabled={broadcastState.kind === "sending"}
                  rows={6}
                  maxLength={8000}
                  className={styles.broadcastTextarea}
                  placeholder="Hi all — just a heads up that we've moved from Pope A17 to Pope B11. Same time, same food. See you there!"
                />
              </Field>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={broadcastIncludeWaitlist}
                  onChange={(e) => setBroadcastIncludeWaitlist(e.target.checked)}
                  disabled={broadcastState.kind === "sending"}
                />
                <span>
                  Include waitlisted attendees ({waitlisted.length}) in addition to
                  confirmed ({confirmed.length})
                </span>
              </label>
              {broadcastState.kind === "error" && (
                <p style={{ color: "var(--color-danger)", margin: 0 }}>
                  {broadcastState.message}
                </p>
              )}
              {broadcastState.kind === "sent" && (
                <p style={{ color: "var(--color-success)", margin: 0 }}>
                  Sent to {broadcastState.sent} attendee
                  {broadcastState.sent === 1 ? "" : "s"}
                  {broadcastState.failed > 0
                    ? ` · ${broadcastState.failed} failed`
                    : ""}
                  .
                </p>
              )}
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button type="submit" disabled={broadcastState.kind === "sending"}>
                  {broadcastState.kind === "sending" ? "Sending…" : "Send update"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setBroadcastOpen(false);
                    setBroadcastState({ kind: "idle" });
                  }}
                  disabled={broadcastState.kind === "sending"}
                >
                  Close
                </Button>
              </div>
            </form>
          </Card>
        )}
      </section>

      {/* Pending change-requests ----------------------------------------- */}
      {pendingChanges.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>
            Pending change requests ({pendingChanges.length})
          </h2>
          <p className={styles.sectionHint}>
            Attendees asking to update their answers (usually dietary tweaks). Approve
            replaces their original answers; deny keeps the originals.
          </p>
          <div className={styles.pendingList}>
            {pendingChanges.map((r) => (
              <Card key={r.id} padding="md">
                <div className={styles.rsvpRow}>
                  <div className={styles.rsvpMain}>
                    <strong>{r.name}</strong>
                    <span className={styles.muted}> · {r.email}</span>
                    <ChangeDiff
                      questions={event.signupForm}
                      current={r.answers}
                      proposed={r.pendingAnswers ?? {}}
                    />
                    {r.pendingAnswersRequestedAt && (
                      <div className={styles.muted}>
                        requested {r.pendingAnswersRequestedAt.toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className={styles.rsvpActions}>
                    <Button
                      onClick={() => onApproveChange(r)}
                      disabled={busyId === r.id}
                    >
                      Approve change
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => onDenyChange(r)}
                      disabled={busyId === r.id}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Pending queue --------------------------------------------------- */}
      {pending.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>
            Pending approval ({pending.length})
          </h2>
          <p className={styles.sectionHint}>
            Approve or deny each RSVP. Approved RSVPs get a spot if capacity
            allows; if full (and waitlist is on) they go on the waitlist.
          </p>
          <div className={styles.pendingList}>
            {pending.map((r) => (
              <Card key={r.id} padding="md">
                <div className={styles.rsvpRow}>
                  <div className={styles.rsvpMain}>
                    <strong>{r.name}</strong>
                    <span className={styles.muted}> · {r.email}</span>
                    <div className={styles.answers}>
                      <AnswerSummary rsvp={r} questions={event.signupForm} />
                    </div>
                    {r.createdAt && (
                      <div className={styles.muted}>
                        submitted {r.createdAt.toLocaleString()}
                      </div>
                    )}
                  </div>
                  <div className={styles.rsvpActions}>
                    <Button
                      onClick={() => onApprove(r)}
                      disabled={busyId === r.id}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDenyFor(r.id);
                        setDenyNote("");
                      }}
                      disabled={busyId === r.id}
                    >
                      Deny…
                    </Button>
                  </div>
                </div>
                {denyFor === r.id && (
                  <div className={styles.denyBox}>
                    <Field id={`deny-${r.id}`} label="Reason (optional, kept for audit)">
                      <Input
                        id={`deny-${r.id}`}
                        value={denyNote}
                        onChange={(e) => setDenyNote(e.target.value)}
                        placeholder="e.g. suspected spam, prior no-show"
                        maxLength={500}
                      />
                    </Field>
                    <div className={styles.denyActions}>
                      <Button
                        onClick={onDenyConfirm}
                        disabled={busyId === r.id}
                      >
                        Deny RSVP
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDenyFor(null);
                          setDenyNote("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      {actionErr && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)", margin: 0 }}>{actionErr}</p>
        </Card>
      )}

      {/* Pizza order helper --------------------------------------------- */}
      {event.signupForm.some((q) => q.type === "multiSelect") && (
        <OrderHelper event={event} rsvps={confirmed} />
      )}

      {/* Charts --------------------------------------------------------- */}
      {active.length > 0 && (
        <section>
          <h2 className={styles.sectionTitle}>Answers (confirmed + waitlisted)</h2>
          <p className={styles.sectionHint}>
            Live breakdown — use these numbers when ordering food.
          </p>
          <div className={styles.chartsGrid}>
            {event.signupForm.map((q) => (
              <QuestionChart key={q.id} question={q} rsvps={active} />
            ))}
            {event.signupForm.length === 0 && (
              <Card padding="md">
                <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
                  No signup questions on this event — nothing to chart.
                </p>
              </Card>
            )}
          </div>
        </section>
      )}

      {/* Attendee table + export ---------------------------------------- */}
      <section>
        <div className={styles.tableHeader}>
          <h2 className={styles.sectionTitle}>All RSVPs</h2>
          <div className={styles.tableControls}>
            <label className={styles.filterLabel}>
              <span>Show</span>
              <Select
                value={filter}
                onChange={(e) => setFilter(e.target.value as typeof filter)}
              >
                <option value="active">Active (confirmed + waitlisted)</option>
                <option value="all">All</option>
                {RSVP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RSVP_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </label>
            <Button variant="ghost" onClick={onCopyEmails}>
              Copy emails (active)
            </Button>
            <Button variant="ghost" onClick={onDownloadCSV}>
              Download CSV
            </Button>
          </div>
        </div>
        {copyStatus && (
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {copyStatus}
          </p>
        )}

        {visibleRows.length === 0 ? (
          <Card padding="md">
            <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
              No RSVPs in this view.
            </p>
          </Card>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Answers</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className={styles.mono}>{r.email}</td>
                    <td>
                      <div style={{ display: "flex", gap: "var(--space-1)", flexWrap: "wrap" }}>
                        <Badge tone={statusTone(r.status)}>
                          {RSVP_STATUS_LABEL[r.status]}
                        </Badge>
                        {r.pendingAnswers && (
                          <Badge tone="warning">Change pending</Badge>
                        )}
                      </div>
                    </td>
                    <td className={styles.muted}>
                      {r.createdAt?.toLocaleDateString() ?? "—"}
                    </td>
                    <td>
                      <AnswerSummary rsvp={r} questions={event.signupForm} />
                      {r.decisionNote && (
                        <div className={styles.decisionNote}>
                          <strong>Note:</strong> {r.decisionNote}
                        </div>
                      )}
                    </td>
                    <td className={styles.rowActions}>
                      {r.status !== "cancelled" && r.status !== "denied" && (
                        <button
                          type="button"
                          className={styles.ghostBtnSm}
                          onClick={() => onCancel(r)}
                          disabled={busyId === r.id}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CountBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "accent" | "success" | "danger" | "warning";
}) {
  return (
    <div className={styles.countBox}>
      <div className={styles.countValue}>{value}</div>
      <div className={styles.countLabel}>
        <Badge tone={tone}>{label}</Badge>
      </div>
    </div>
  );
}

function ChangeDiff({
  questions,
  current,
  proposed,
}: {
  questions: FormQuestion[];
  current: Record<string, RsvpAnswer>;
  proposed: Record<string, RsvpAnswer>;
}) {
  const rows = questions
    .map((q) => ({
      q,
      was: renderAnswer(current[q.id]),
      now: renderAnswer(proposed[q.id]),
    }))
    .filter((r) => r.was !== r.now);
  if (rows.length === 0) {
    return (
      <p className={styles.muted}>(No net change — attendee resubmitted same answers.)</p>
    );
  }
  return (
    <ul className={styles.answerList}>
      {rows.map(({ q, was, now }) => (
        <li key={q.id}>
          <span className={styles.answerLabel}>{q.label}:</span>{" "}
          <span style={{ textDecoration: "line-through", color: "var(--color-text-muted)" }}>
            {was || "(empty)"}
          </span>{" "}
          → <strong>{now || "(empty)"}</strong>
        </li>
      ))}
    </ul>
  );
}

function AnswerSummary({
  rsvp,
  questions,
}: {
  rsvp: RsvpDoc;
  questions: FormQuestion[];
}) {
  if (questions.length === 0) return <span className={styles.muted}>—</span>;
  return (
    <ul className={styles.answerList}>
      {questions.map((q) => {
        const val = renderAnswer(rsvp.answers[q.id]);
        if (!val) return null;
        return (
          <li key={q.id}>
            <span className={styles.answerLabel}>{q.label}:</span> {val}
          </li>
        );
      })}
    </ul>
  );
}

function QuestionChart({
  question,
  rsvps,
}: {
  question: FormQuestion;
  rsvps: RsvpDoc[];
}) {
  if (question.type === "shortText" || question.type === "longText") {
    const answers = rsvps
      .map((r) => ({ name: r.name, value: renderAnswer(r.answers[question.id]) }))
      .filter((a) => a.value);
    return (
      <Card padding="md">
        <h3 className={styles.chartTitle}>{question.label}</h3>
        {answers.length === 0 ? (
          <p className={styles.muted}>No responses.</p>
        ) : (
          <ul className={styles.textAnswerList}>
            {answers.map((a, i) => (
              <li key={i}>
                <strong>{a.name}:</strong> {a.value}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  // Aggregate into slices.
  const counts = new Map<string, number>();
  for (const r of rsvps) {
    const a = r.answers[question.id];
    if (a === undefined) continue;

    if (question.type === "yesNo") {
      if (typeof a === "boolean") {
        const k = a ? "Yes" : "No";
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    } else if (question.type === "singleSelect") {
      if (typeof a === "string" && a) {
        counts.set(a, (counts.get(a) ?? 0) + 1);
      }
    } else if (question.type === "multiSelect") {
      if (Array.isArray(a)) {
        for (const v of a) {
          if (typeof v === "string" && v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      } else if (a && typeof a === "object") {
        const obj = a as { checked?: string[]; other?: string };
        if (Array.isArray(obj.checked)) {
          for (const v of obj.checked) {
            if (typeof v === "string" && v) counts.set(v, (counts.get(v) ?? 0) + 1);
          }
        }
        if (obj.other) counts.set("Other", (counts.get("Other") ?? 0) + 1);
      }
    } else if (question.type === "dietaryAllergies") {
      if (a && typeof a === "object" && !Array.isArray(a)) {
        const obj = a as { checked?: string[]; other?: string };
        if (Array.isArray(obj.checked)) {
          for (const v of obj.checked) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        if (obj.other) counts.set("Other", (counts.get("Other") ?? 0) + 1);
      }
    }
  }

  // Only chart what people actually picked — an all-zero pie is just noise.
  const slices: PieSlice[] = Array.from(counts.entries())
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count], i) => ({ label, count, color: pickColor(i) }));

  const totalResponses = rsvps.filter((r) => r.answers[question.id] !== undefined).length;
  const multiPick =
    question.type === "multiSelect" || question.type === "dietaryAllergies";

  return (
    <Card padding="md">
      <h3 className={styles.chartTitle}>{question.label}</h3>
      {slices.length === 0 ? (
        <p className={styles.muted}>No responses yet.</p>
      ) : (
        <>
          <p className={styles.muted}>
            {totalResponses} response{totalResponses === 1 ? "" : "s"}
            {multiPick ? " · multiple picks per person" : ""} · hover a slice for
            detail
          </p>
          <Pie slices={slices} />
        </>
      )}
    </Card>
  );
}
