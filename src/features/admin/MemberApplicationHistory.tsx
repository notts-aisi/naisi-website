"use client";

import Chip, { type ChipTone } from "@/components/ui/Chip";
import MemberText from "@/components/ui/MemberText";
import { APPLICATION_STATUS_TONE } from "@/features/admissions/applicationStatus";
import { ADMISSION_APPLICATION_STATUS_LABEL } from "@/lib/firestore/admissionApplications";
import type { ApplicationRecordDoc } from "@/lib/firestore/memberRecords";
import { useMemberApplications } from "./useMemberApplications";
import styles from "./MemberApplicationHistory.module.css";

type Props = {
  uid: string;
};

/**
 * The member record on the admin Members row: every round this person applied
 * to, what they applied for, what was decided, how they scored and what the
 * reviewers wrote.
 *
 * ## Why it exists on this page
 *
 * A round can be destroyed. When it is, the applications, the reviews and the
 * scores go with it, and what survives is this record, written per person
 * before the destroy touches anything. So this panel is the only place a
 * committee grading somebody's second application can read what was thought of
 * their first. It sits on the Members row rather than anywhere in the
 * admissions console for the same reason: it hangs off the person, and it
 * outlives every round on it.
 *
 * ## Names are already in the record
 *
 * `reviewerName` is stored on the entry, resolved when it was written. This
 * component never reads `users`, which is what lets an entry keep saying who
 * wrote a note after that reviewer has closed their account, and what keeps
 * the panel to one listener on one subcollection.
 *
 * ## The text is member and reviewer prose
 *
 * Notes go through `MemberText`: a text node, never markdown, never HTML, and
 * never linkified. A reviewer's note is free text typed by one person about
 * another, so it is the same trust boundary as anything a member writes.
 */
export default function MemberApplicationHistory({ uid }: Props) {
  const { applications, loading, error } = useMemberApplications(uid);

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>Applications</h3>
      <p className={styles.note}>
        Entries are written when a round settles, or when a round is destroyed, whichever
        comes first.
      </p>

      {loading && <p className={styles.muted}>Loading…</p>}

      {error !== null && !loading && (
        <p className={styles.error}>
          Could not load this member&apos;s application record.
        </p>
      )}

      {!loading && error === null && applications.length === 0 && (
        <p className={styles.muted}>No applications on record.</p>
      )}

      {applications.map((entry) => (
        <ApplicationEntry key={entry.id} entry={entry} />
      ))}
    </section>
  );
}

/** One round's entry. Split out so the map above reads as a list of rounds. */
function ApplicationEntry({ entry }: { entry: ApplicationRecordDoc }) {
  const applied = formatDay(entry.appliedAt);
  const submitted = formatDay(entry.submittedAt);

  return (
    <article className={styles.entry}>
      <header className={styles.entryHead}>
        <span className={styles.title}>{entry.roundTitle || "Untitled round"}</span>
        <Chip size="sm" tone="neutral">
          {roundKindLabel(entry.roundKind)}
        </Chip>
        <Chip size="sm" tone={statusTone(entry.outcome.status)}>
          {statusLabel(entry.outcome.status)}
        </Chip>
      </header>

      {/* Two dates, and the fallbacks say which one is missing rather than
          inventing a story about it. A record with no submission date is
          usually a draft nobody sent, but it can also be an entry written from
          an application whose stamp never landed, and the status chip above is
          the field that settles which. */}
      <p className={styles.dates}>
        {applied ? `Applied ${applied}` : "No application date recorded"}
        {submitted ? `, submitted ${submitted}` : ", no submission recorded"}
      </p>

      {entry.appliedFor.length > 0 && (
        <p className={styles.appliedFor}>
          <span className={styles.fieldLabel}>Applied for:</span>{" "}
          {entry.appliedFor.join(", ")}
        </p>
      )}

      {/* The decision is what the final decider pressed, which is not always
          readable off the status (a declined facilitator and a rejected
          applicant land on the same status from different buttons). The run a
          place was on is deliberately NOT shown: the record stores its id and
          no label, and resolving one would mean a lookup this panel is built
          to avoid, against a run a destroy may already have removed. */}
      {entry.outcome.decision !== null && (
        <p className={styles.decision}>
          <span className={styles.fieldLabel}>Decision:</span> {entry.outcome.decision}
        </p>
      )}

      <p className={styles.score}>{scoreSentence(entry.scoreSummary)}</p>

      {entry.reviewerNotes.length > 0 && (
        <ul className={styles.notes}>
          {/* Keyed by uid AND position. One note per reviewer is what the
              writer produces, but nothing on the read path dedupes, so a
              malformed entry with the same reviewer twice would otherwise hand
              React two identical keys and drop a note quietly rather than show
              the duplicate an admin needs to see. */}
          {entry.reviewerNotes.map((note, index) => (
            <li key={`${note.reviewerUid}-${index}`} className={styles.reviewerNote}>
              <div className={styles.noteHead}>
                {/* No fallback here on purpose. `normalizeApplicationRecord`
                    already substitutes the repo-wide `UNNAMED_REVIEWER` label
                    for a missing name (and for a stored value that looks like
                    an email address), so a second fallback of different wording
                    would only make the same absence read two ways depending on
                    which reader got there first. */}
                <span className={styles.reviewer}>{note.reviewerName}</span>
                {note.recommendation !== null && (
                  <Chip size="sm" tone={recommendationTone(note.recommendation)}>
                    {recommendationLabel(note.recommendation)}
                  </Chip>
                )}
                {note.total !== null && (
                  <span className={styles.reviewerTotal}>scored {note.total}</span>
                )}
              </div>
              {note.notes.trim() ? (
                <MemberText text={note.notes} className={styles.noteText} />
              ) : (
                <p className={styles.muted}>No notes written.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* WHEN this copy was taken, and by which event. The standing note at the
          top of the panel can only say that entries come from a settle or a
          destroy; per entry it is a fact worth having, because it is the
          difference between "this is what the round decided" and "this is what
          the round had decided at the moment somebody destroyed it", and after
          a destroy there is nothing left to check it against. */}
      <p className={styles.provenance}>{provenanceSentence(entry)}</p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Labels and tones
//
// Every field the record stores as a bare string is read DEFENSIVELY here. The
// entry is a copy taken at settle or destroy time, so it can outlive the union
// it was written from: a round kind or a status renamed next year leaves old
// entries carrying the old word, and showing that word is better than showing
// a blank where a decision used to be.
// ---------------------------------------------------------------------------

const ROUND_KIND_LABEL: Record<string, string | undefined> = {
  enrolment: "Intake",
  appointment: "Facilitator",
};

const RECOMMENDATION_LABEL: Record<string, string | undefined> = {
  advance: "Advance",
  hold: "Hold",
  decline: "Decline",
};

const RECOMMENDATION_TONE: Record<string, ChipTone | undefined> = {
  advance: "success",
  hold: "warning",
  decline: "neutral",
};

function roundKindLabel(kind: string): string {
  return ROUND_KIND_LABEL[kind] ?? (kind || "Round");
}

function recommendationLabel(recommendation: string): string {
  return RECOMMENDATION_LABEL[recommendation] ?? recommendation;
}

function recommendationTone(recommendation: string): ChipTone {
  return RECOMMENDATION_TONE[recommendation] ?? "neutral";
}

function statusLabel(status: string): string {
  const labels: Record<string, string | undefined> = ADMISSION_APPLICATION_STATUS_LABEL;
  return labels[status] ?? (status || "Unknown");
}

function statusTone(status: string): ChipTone {
  const tones: Record<string, ChipTone | undefined> = APPLICATION_STATUS_TONE;
  return tones[status] ?? "neutral";
}

function formatDay(value: Date | null): string | null {
  if (!value) return null;
  return value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The one-line score summary.
 *
 * Both numbers are optional in the record, and each absence means something
 * different: no reviewers at all (a round settled before anybody read this
 * application), or reviewers who left notes without scoring. Saying which is
 * the difference between "nobody looked" and "they looked and did not score",
 * which is exactly the distinction a committee grading a second application
 * needs.
 *
 * The reviewer count and the mean are stated as two facts rather than as
 * "mean X over N reviewers", because the record counts every reviewer who
 * assessed the application while the mean divides by the ones who SCORED it.
 * Where those differ, the shorter sentence would be quietly wrong.
 */
/**
 * The provenance line: which event wrote this entry, and when.
 *
 * The event is named rather than the writer's uid. A uid resolves to nobody an
 * admin recognises without the lookup this panel exists without, and the
 * question the line answers is about the ROUND ("was this copied while the
 * round was still running?"), not about which admin pressed the button, which
 * `destroyAudits` records properly.
 *
 * `backfill` is the honest word for both a real backfill tool and a value this
 * build cannot name (see `normalizeApplicationRecord`), so it claims no
 * particular event: "added to the record" rather than a settle or a destroy.
 */
function provenanceSentence(entry: ApplicationRecordDoc): string {
  const when = formatDay(entry.writtenAt);
  const event =
    entry.writtenBy === "settle"
      ? "Recorded when the round settled"
      : entry.writtenBy === "destroy"
        ? "Recorded when the round was destroyed"
        : "Added to the record afterwards";
  return when ? `${event}, ${when}.` : `${event}.`;
}

function scoreSentence(summary: ApplicationRecordDoc["scoreSummary"]): string {
  if (summary.reviewerCount <= 0) return "No reviews on record.";
  const reviewers = `${summary.reviewerCount} reviewer${summary.reviewerCount === 1 ? "" : "s"}`;
  if (summary.mean === null) return `${reviewers}, no scores recorded.`;
  const mean = Number.isInteger(summary.mean)
    ? String(summary.mean)
    : summary.mean.toFixed(1);
  if (summary.total === null) return `${reviewers}, mean ${mean}.`;
  return `${reviewers}, mean ${mean} (${summary.total} in total).`;
}
