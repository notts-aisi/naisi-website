"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import MemberText from "@/components/ui/MemberText";
import Select from "@/components/ui/Select";
import Switch from "@/components/ui/Switch";
import type {
  AppointmentQueueRow,
  AppointmentRunOption,
} from "@/lib/admissions/appointmentQueue";
import type { QueueTruncation } from "@/lib/admissions/appointmentQueueData";
import styles from "./AppointmentsQueue.module.css";

/**
 * The appointment queue, rendered.
 *
 * ## Deliberately plain
 *
 * This is a list, the answers, an availability summary and two buttons. There
 * is no scoring, no blind review, no coverage meter and no bulk action,
 * because a facilitator round appoints five or six people and every one of
 * those affordances is machinery for ranking ninety. The queue is worked
 * through once, on the evening the round closes, and the thing it has to be is
 * legible on a phone at 23:00.
 *
 * ## Every applicant string goes through MemberText
 *
 * Answers, names and preferred names are all typed by the applicant. They are
 * rendered as text nodes and nothing else: no markdown, no linkification, and
 * no raw-HTML renderer anywhere on this surface. The decider's own note takes
 * the same route on the other side: the email component renders it as a `Text`
 * node rather than putting it through the block path.
 *
 * ## Neither button decides on one press
 *
 * Both are irreversible from this page: an appointment writes a uid onto a
 * run and mails the person, a decline mails them too, and the route refuses to
 * overwrite either afterwards because the email has already gone. So each
 * press opens a confirm step that names the person and, for an appointment,
 * the run, and for a decline says whether the note is going with it. A queue
 * worked at 23:00 on a phone is exactly where a mis-tap happens.
 *
 * ## The page reloads after a decide rather than patching state
 *
 * `router.refresh()` re-runs the server component, which re-reads the round,
 * the applications and the runs. A decide moves a counter on the round and a
 * uid onto a run, so a client-side patch would leave two numbers on this page
 * disagreeing with Firestore until somebody reloaded. The list is a few dozen
 * rows: correctness is worth the round trip.
 */

type Props = {
  roundId: string;
  roundLabel: string;
  rows: AppointmentQueueRow[];
  runs: AppointmentRunOption[];
  /**
   * The runs the ROUND names, straight off `admissionRounds.outcomeRunIds`.
   *
   * Read for one thing only: whether the round names exactly one run this
   * queue could appoint onto, which is the only case where the picker may
   * open on a run rather than on its placeholder. Today's write path refuses
   * to put a run here on an appointment round (the PATCH route in
   * `api/admissions/rounds/[roundId]`), so in practice the list is empty and
   * the decider chooses. It is honoured rather than assumed away because the
   * document, not the route, is what this page renders.
   */
  outcomeRunIds: string[];
  /** What the applications cap left out, or null when it left nothing out. */
  rowsTruncated: QueueTruncation;
  /** What the runs cap left out, or null. */
  runsTruncated: QueueTruncation;
  canDecide: boolean;
  /**
   * Why this round cannot be decided right now (archived, still a draft,
   * cancelled), or null when it can. The queue still READS in that state: a
   * decided round that was later cancelled is exactly what somebody comes here
   * to look up. Only the buttons go.
   */
  decideBlock: string | null;
};

const NOTE_MAX = 500;

export default function AppointmentsQueue({
  roundId,
  roundLabel,
  rows,
  runs,
  outcomeRunIds,
  rowsTruncated,
  runsTruncated,
  canDecide,
  decideBlock,
}: Props) {
  const undecided = rows.filter((row) => !row.outcome).length;
  const deciding = canDecide && !decideBlock;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <Link className={styles.back} href={`/admin/admissions/${roundId}`}>
          ← Back to the round
        </Link>
        <h1 className={styles.title}>Appointments</h1>
        <p className={styles.hint}>
          {roundLabel} · {rows.length}{" "}
          {rows.length === 1 ? "application" : "applications"} · {undecided} still to
          decide
        </p>
        {/* Said rather than implied. Somebody arriving from the reviewing side
            of the console will expect the names to be hidden, and finding them
            visible with no explanation reads as a bug in the blinding. */}
        <p className={styles.notice}>
          This queue is <strong>not name-blind</strong>. Appointing somebody to run a
          group is a judgement about a person the committee knows, so the names, the
          preferred names and the addresses are all here. Access requirements are not:
          that answer is kept separately and every read of it is recorded.
        </p>
        {!canDecide && (
          <p className={styles.notice}>
            You can read this queue but not decide on it. Appointments are made by the
            round&apos;s final decider or an admin.
          </p>
        )}
        {/* Said in words, and the same sentence the route would answer with.
            A hidden button with no explanation reads as a broken page. */}
        {canDecide && decideBlock && <p className={styles.notice}>{decideBlock}</p>}
        {/* The count is of what was READ, which is not the same number as the
            rows below: drafts and withdrawals are dropped after the read. So
            the line is about the read rather than about the list. */}
        {rowsTruncated && (
          <p className={styles.notice}>
            Only the first {rowsTruncated.shown} of {rowsTruncated.total} applications
            on this round were read. The rest are not on this page.
          </p>
        )}
        {deciding && runsTruncated && (
          <p className={styles.notice}>
            Only the first {runsTruncated.shown} of {runsTruncated.total} runs were
            read, so a run you expect may not be in the list below.
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <Card>
          <p className={styles.hint}>
            Nothing submitted yet. Drafts do not appear here: an application shows up
            when somebody presses submit.
          </p>
        </Card>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.applicationId}>
              <ApplicantCard
                roundId={roundId}
                row={row}
                runs={runs}
                outcomeRunIds={outcomeRunIds}
                canDecide={deciding}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApplicantCard({
  roundId,
  row,
  runs,
  outcomeRunIds,
  canDecide,
}: {
  roundId: string;
  row: AppointmentQueueRow;
  runs: AppointmentRunOption[];
  outcomeRunIds: string[];
  canDecide: boolean;
}) {
  const router = useRouter();
  // OPENS ON NOTHING, BECAUSE NOBODY MEANT THE FIRST ONE. This used to
  // default to the first appointable run in the whole project, which on a
  // shared project is another round's run and in production is whichever
  // sorts first: a decider who never looked at this select would appoint
  // somebody onto a run nobody chose, and the email goes out on the press.
  // The one exception is a round that names exactly one run this queue could
  // appoint onto, where there is nothing to choose between.
  const appointable = runs.filter((run) => run.startDate !== "");
  const named = outcomeRunIds.filter((id) =>
    appointable.some((run) => run.id === id),
  );
  const [runId, setRunId] = useState(named.length === 1 ? named[0] : "");
  const [note, setNote] = useState("");
  const [shareReason, setShareReason] = useState(false);
  const [confirm, setConfirm] = useState<"appoint" | "decline" | null>(null);
  const [busy, setBusy] = useState<"appoint" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decided = row.outcome;
  const chosen = runs.find((run) => run.id === runId) ?? null;
  const canAppoint = chosen !== null && chosen.startDate !== "";
  // WHY APPOINT IS OUT OF REACH, in the decider's terms. Three different
  // situations reach the same disabled button and they are not the same
  // problem: a run picked that has no first day, a list where none of them
  // has one, and a picker nobody has answered yet.
  //
  // The first of those cannot be reached from this page as it stands: a
  // dateless run renders as a disabled option and the pre-fill only ever takes
  // a dated one. It is kept because it is the arm that stops being unreachable
  // the moment a dateless option becomes pickable, and "Pick the run first" is
  // the wrong sentence to show somebody who has already picked one.
  const appointBlock =
    canAppoint || runs.length === 0
      ? null
      : chosen !== null
        ? "That run has no start date yet. The appointment email names the first day, so give the run a date before appointing anybody onto it."
        : appointable.length === 0
          ? "No run in the list has a start date yet. The appointment email names the first day, so give one a date before appointing anybody onto it."
          : "Pick the run first. An appointment emails the person straight away, and the email names the run they are joining.";

  async function decide(decision: "appoint" | "decline") {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(
        `/api/admissions/rounds/${encodeURIComponent(roundId)}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            applicationId: row.applicationId,
            decision,
            ...(decision === "appoint" ? { runId } : {}),
            note,
            ...(decision === "decline" ? { reasonShared: shareReason } : {}),
          }),
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That did not go through.");
        return;
      }
      setConfirm(null);
      router.refresh();
    } catch {
      setError("That did not go through. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card as="article" className={styles.card} data-testid="appointment-card">
      <div className={styles.cardHead}>
        {/* A `div` with an explicit heading role rather than an `h2`, because
            `MemberText` renders a `div` and a `div` inside an `h2` is invalid.
            The rule that member-authored text goes through MemberText wins
            over the tag: the tag is fixable with a role, the escaping is not
            fixable at all. */}
        <div className={styles.who}>
          <div className={styles.name} role="heading" aria-level={2}>
            <MemberText text={row.displayName || "Unnamed applicant"} />
          </div>
          {row.preferredName && (
            <div className={styles.preferred}>
              <span>Goes by</span>
              <MemberText text={row.preferredName} />
            </div>
          )}
          <p className={styles.meta}>
            {[row.email, row.universityEmail].filter(Boolean).join(" · ") ||
              "No address on file"}
          </p>
        </div>
        <div className={styles.chips}>
          {decided ? (
            <Badge tone={decided.decision === "appoint" ? "success" : "neutral"}>
              {decided.decision === "appoint" ? "Appointed" : "Declined"}
            </Badge>
          ) : (
            <Badge tone="accent">To decide</Badge>
          )}
          {row.membershipAtApply && <Badge tone="neutral">Paid member</Badge>}
        </div>
      </div>

      <Availability availability={row.availability} />

      {row.stages.map((stage) => (
        <section key={stage.stageId} className={styles.stage}>
          <h3 className={styles.stageTitle}>{stage.label}</h3>
          {stage.answers.length === 0 ? (
            <p className={styles.hint}>
              {stage.released
                ? "No questions on this part."
                : "This part has not been released yet, so there is nothing to read."}
            </p>
          ) : (
            <dl className={styles.answers}>
              {stage.answers.map((answer) => (
                <div key={answer.questionId} className={styles.answer}>
                  <dt className={styles.question}>{answer.label}</dt>
                  <dd className={styles.value}>
                    {answer.text ? (
                      <MemberText text={answer.text} />
                    ) : (
                      <span className={styles.hint}>Not answered</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}

      {decided ? (
        <div className={styles.outcome}>
          <p className={styles.hint} data-testid="appointment-decided">
            {decided.decision === "appoint"
              ? `Appointed${decided.runId ? ` to ${runName(runs, decided.runId)}` : ""}. The email has gone out.`
              : "Declined. The email has gone out."}
          </p>
          {decided.sharedReason ? (
            <>
              <p className={styles.hint}>They were sent this note:</p>
              <MemberText className={styles.note} text={decided.sharedReason} />
            </>
          ) : null}
        </div>
      ) : canDecide ? (
        <div className={styles.decide}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Run</span>
            <Select
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              disabled={runs.length === 0}
              data-testid="appointment-run-select"
            >
              {runs.length === 0 ? (
                <option value="">No run can take a facilitator</option>
              ) : (
                <>
                  {/* The placeholder is a real option rather than an absence,
                      so a picker that has not been answered reads as one. */}
                  <option value="">Choose a run</option>
                  {runs.map((run) => (
                    // A DATELESS RUN IS LISTED BUT UNPICKABLE. The appointment
                    // email names the first day, so the route refuses one, and
                    // hiding the run entirely would leave somebody hunting for
                    // a run they can see in the console. Named, greyed, with
                    // the reason on it.
                    <option key={run.id} value={run.id} disabled={run.startDate === ""}>
                      {run.courseTitle} · {run.label}
                      {run.startDate === "" ? " (no start date yet)" : ""}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              Note in the email (training dates, where to be)
            </span>
            <CountedTextarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              max={NOTE_MAX}
              rows={3}
              placeholder="Facilitator training is Wednesday 8 October, 18:00 to 20:00 in Hallward B12."
            />
          </label>

          <div className={styles.share}>
            <Switch
              checked={shareReason}
              onChange={setShareReason}
              label="Send this note if you decline"
              description="An appointment always sends it. A decline sends it only if this is on."
            />
          </div>

          {appointBlock && <p className={styles.hint}>{appointBlock}</p>}

          {error && <p className={styles.error}>{error}</p>}

          {confirm === null ? (
            <div className={styles.actions}>
              <Button
                type="button"
                variant="primary"
                data-testid="appointment-appoint"
                onClick={() => {
                  setError(null);
                  setConfirm("appoint");
                }}
                disabled={busy !== null || !canAppoint}
              >
                Appoint
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-testid="appointment-decline"
                onClick={() => {
                  setError(null);
                  setConfirm("decline");
                }}
                disabled={busy !== null}
              >
                Decline
              </Button>
            </div>
          ) : (
            <div className={styles.confirm}>
              <p className={styles.confirmLead}>
                {confirm === "appoint"
                  ? "Appoint this person and email them now?"
                  : "Tell this person we cannot take them on?"}
              </p>
              {/* The name goes through MemberText here too. It is the same
                  applicant-typed string it is at the top of the card. */}
              <MemberText
                className={styles.confirmName}
                text={row.displayName || "this applicant"}
              />
              <p className={styles.hint}>
                {confirm === "appoint"
                  ? `They join ${chosen ? `${chosen.courseTitle} ${chosen.label}`.trim() : "the run"} as a facilitator and are emailed straight away.`
                  : shareReason && note.trim()
                    ? "Your note is sent to them with it."
                    : "Your note stays with us: it is not sent to them."}{" "}
                This page cannot undo it afterwards.
              </p>
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant={confirm === "appoint" ? "primary" : "danger"}
                  data-testid="appointment-confirm"
                  onClick={() => decide(confirm)}
                  disabled={busy !== null}
                >
                  {busy === "appoint"
                    ? "Appointing…"
                    : busy === "decline"
                      ? "Sending…"
                      : confirm === "appoint"
                        ? "Yes, appoint"
                        : "Yes, decline"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setConfirm(null)}
                  disabled={busy !== null}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A decided row's run, named rather than shown as a document id. The run may
 * no longer be in the eligible list (it can finish, or be archived, long after
 * somebody was appointed to it), and then the id is the honest answer: it is
 * still a thing an admin can look up, and inventing a label would not be.
 */
function runName(runs: AppointmentRunOption[], runId: string): string {
  const run = runs.find((r) => r.id === runId);
  return run ? `${run.courseTitle} ${run.label}`.trim() : runId;
}

function Availability({
  availability,
}: {
  availability: AppointmentQueueRow["availability"];
}) {
  if (availability.markedSlots === 0) {
    return (
      <p className={styles.hint}>
        They marked no in-person availability. Ask them before putting them on a group.
      </p>
    );
  }
  return (
    <section className={styles.stage}>
      <h3 className={styles.stageTitle}>Can be in a room</h3>
      <ul className={styles.days}>
        {availability.days.map((day) => (
          <li key={day.weekday} className={styles.day}>
            <span className={styles.dayName}>{day.label}</span>
            <span className={styles.spans}>{day.spans.join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
