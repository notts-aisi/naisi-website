"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import DateTimePopover from "@/components/ui/DateTimePopover";
import { Field, Input } from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import PersonSelector from "@/components/ui/PersonSelector";
import Select from "@/components/ui/Select";
import Switch from "@/components/ui/Switch";
import { useMembers } from "@/features/admin/useMembers";
import { getClientDb } from "@/lib/firebase/client";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  ADMISSION_ROUND_KIND_LABEL,
  ADMISSION_ROUND_STATUS_LABEL,
  type AdmissionCriterion,
  type AdmissionRoundStatus,
} from "@/lib/firestore/admissionRounds";
import SlotListEditor from "@/features/reminders/SlotListEditor";
import { validateSlots, type ReminderSlot } from "@/lib/reminders/slots";
import { appointmentDecideBlock } from "@/lib/admissions/appointmentRules";
import { nextStatuses, planStatusChange } from "@/lib/admissions/roundStatus";
import { normalizeCourseRun, type CourseRunDoc } from "@/lib/firestore/courses";
import DestroyPanel from "@/features/destroy/DestroyPanel";
import AppointmentsLink from "./AppointmentsLink";
import ReadinessPanel from "./ReadinessPanel";
import SectionCard from "./SectionCard";
import SendRemindersNow from "./SendRemindersNow";
import StagesSection from "./StagesSection";
import {
  RoundApiError,
  fetchRound,
  patchRound,
  setRoundRoles,
  setRoundStatus,
  type Round,
  type Stage,
} from "./roundClient";
import styles from "./RoundEditor.module.css";

const L = ADMISSION_ROUND_FIELD_LIMITS;

const STATUS_TONE: Record<
  AdmissionRoundStatus,
  "neutral" | "accent" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  open: "success",
  closed: "warning",
  deciding: "accent",
  settled: "neutral",
  cancelled: "danger",
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** "09:00" from minutes past midnight, and back. The grid stores minutes. */
function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clockToMinutes(clock: string, fallback: number): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The round authoring console.
 *
 * ## Everything is a route call
 *
 * Unlike the course editors, which write client-direct, every read and write
 * here goes through `/api/admissions/rounds`. `admissionRounds` is
 * `allow read, write: if false` on both halves, so there is no client-direct
 * path to fall back on, and that is deliberate: the round carries live
 * application counters and the name of the person who decides each
 * application.
 *
 * ## Sections save themselves
 *
 * Each section owns its own draft state and its own save. The PATCH route is
 * partial, so a section sends only its own fields, which is what keeps the
 * submitted-applications freeze on criteria and programme preference from
 * firing every time somebody fixes a typo in the standfirst.
 *
 * ## The readiness panel is not advice
 *
 * It renders `roundReadiness`, the same predicate the status route refuses
 * `draft -> open` on. Whatever the panel lists is exactly what the Open button
 * will answer 409 with, so there is never a green tick beside a refusal.
 */
export default function RoundEditor({
  roundId,
  isAdmin,
}: {
  roundId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [round, setRound] = useState<Round | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<CourseRunDoc[]>([]);

  /**
   * ONE load, called by the mount effect and by anything that needs a reread.
   * Promise chain rather than an awaited call, and state set only from the
   * callbacks: the shape the admin lists use, so nothing updates synchronously
   * inside the effect body.
   *
   * `isCancelled` is how the effect's cleanup reaches in. Copying the body
   * into the effect to get that guard was two loads to keep in step, and the
   * copy that drifts is the one nobody is looking at.
   */
  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetchRound(roundId)
        .then((data) => {
          if (isCancelled()) return;
          setRound(data.round);
          setStages(data.stages);
          setCanAuthor(data.canAuthor);
          setError(null);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          setError(err instanceof Error ? err.message : "Could not load this round.");
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        }),
    [roundId],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * The run pickers, read straight from Firestore. Tens of documents at NAISI
   * scale: one read beats a route that would only re-serve the same rows.
   *
   * Gated on `canAuthor`, and that gate is the rule rather than a tidy-up.
   * An unfiltered list of `courseRuns` is allowed to admins, to a run's own
   * author, and to `draftCourse` / `approveCourse` holders; everybody else may
   * only list runs with a status filter on the query. An admissions reviewer
   * appointed to this round holds none of those, so firing this on mount would
   * hand them a permission-denied on every visit for rows the page never shows
   * them: `runs` is consumed only inside the `canAuthor` branch below.
   */
  useEffect(() => {
    if (!canAuthor) return;
    let cancelled = false;
    getDocs(collection(getClientDb(), "courseRuns"))
      .then((snap) => {
        if (cancelled) return;
        setRuns(snap.docs.map((d) => normalizeCourseRun(d.id, d.data())));
      })
      .catch(() => {
        /* the run pickers degrade to "no runs found"; nothing else needs them */
      });
    return () => {
      cancelled = true;
    };
  }, [canAuthor]);

  const patch = useCallback(
    async (fields: Record<string, unknown>) => {
      const next = await patchRound(roundId, fields);
      setRound(next);
    },
    [roundId],
  );

  if (loading) return <p className={styles.hint}>Loading the round…</p>;
  if (error || !round) {
    return (
      <div className={styles.column}>
        <p className={styles.error}>{error ?? "Round not found."}</p>
        <Link className={styles.back} href="/admin/admissions">
          Back to rounds
        </Link>
      </div>
    );
  }

  return (
    <div className={`${styles.page} ${canAuthor ? "" : styles.pageSolo}`}>
      <div className={styles.column}>
        <header className={styles.head}>
          <Link className={styles.back} href="/admin/admissions">
            ← All rounds
          </Link>
          <div className={styles.headRow}>
            <h1 className={styles.title}>{round.label}</h1>
            <Badge tone={STATUS_TONE[round.status]} data-testid="round-status-badge">
              {ADMISSION_ROUND_STATUS_LABEL[round.status]}
            </Badge>
            {round.archived && <Badge tone="neutral">Archived</Badge>}
          </div>
          <p className={styles.hint}>
            {ADMISSION_ROUND_KIND_LABEL[round.kind]}
            {round.academicYear ? ` · ${round.academicYear}` : ""} ·{" "}
            {round.applicationCounts.submitted} submitted,{" "}
            {round.applicationCounts.draft} in progress
          </p>
        </header>

        {!canAuthor ? (
          <ReviewerSummary round={round} stages={stages} />
        ) : (
          <>
            <DetailsSection round={round} patch={patch} />
            <WindowSection round={round} patch={patch} />
            <SectionCard id="stages" title="Stages and questions" note="Each stage is a block of questions with its own release date. A stage with no release date opens with the round.">
              <StagesSection
                round={round}
                stages={stages}
                onStagesChange={setStages}
                onRoundChange={(stageIds) => setRound({ ...round, stageIds })}
              />
            </SectionCard>
            {round.kind === "appointment" && (
              <AppointmentsLink
                roundId={round.id}
                // One rule, one place. The queue's own page and the decide
                // route ask the same function.
                readOnly={appointmentDecideBlock(round) !== null}
              />
            )}
            {round.kind === "enrolment" ? (
              <ProgrammeSection round={round} runs={runs} patch={patch} />
            ) : (
              <AppointmentProgrammeNote />
            )}
            <OutcomesSection round={round} runs={runs} patch={patch} />
            <AvailabilitySection round={round} patch={patch} />
            <AccessSection round={round} patch={patch} />
            <CriteriaSection round={round} patch={patch} />
            <RolesSection round={round} isAdmin={isAdmin} onSaved={setRound} />
            <RemindersSection round={round} patch={patch} />
            <StatusSection round={round} onChanged={load} patch={patch} />
            {/*
              The danger zone, admin only and last on the page.

              Cancelling is the everyday way to end a round and it lives in
              the Status section above, where the rest of the lifecycle is:
              it keeps every application and review readable as history.
              Destroying is the other thing entirely, so it sits below
              everything else behind its own disclosure, its own manifest and
              a typed confirmation.

              `isAdmin` is a rendering decision and nothing more. An
              `approveCourse` holder authors rounds and reaches this page, but
              destroying one removes other people's applications, the
              access-requirements answers beside them and the reviewers'
              notes, so both routes refuse anybody but an admin whatever this
              page draws.

              Destroying deletes the round document, so there is nothing left
              to re-read: the panel hands back to the round list rather than
              to a page that would 404.
            */}
            {isAdmin && (
              <DestroyPanel
                kind="admission-round"
                targetId={round.id}
                label={round.label}
                nameLabel="round label"
                subtitle={
                  round.academicYear
                    ? `${ADMISSION_ROUND_KIND_LABEL[round.kind]} · ${round.academicYear}`
                    : ADMISSION_ROUND_KIND_LABEL[round.kind]
                }
                onDestroyed={() => router.push("/admin/admissions")}
              />
            )}
          </>
        )}
      </div>

      {/* Every line in the panel links to a section that only an author has,
          and every blocker it lists is somebody else's job to clear. A
          reviewer reading "3 things still to do" beside links that go nowhere
          is being handed work they cannot do. */}
      {canAuthor && (
        <aside className={styles.side}>
          <ReadinessPanel
            round={{
              kind: round.kind,
              status: round.status,
              closesAt: round.closesAt,
              decisionsByDate: round.decisionsByDate,
              outcomeRunIds: round.outcomeRunIds,
              reviewerUids: round.reviewerUids,
              finalDeciderUid: round.finalDeciderUid,
              stages: stages.map((s) => ({
                id: s.id,
                order: s.order,
                questionCount: s.questionCount,
              })),
            }}
          />
        </aside>
      )}
    </div>
  );
}

/**
 * What a reviewer sees. They reach this page from the Admissions nav entry,
 * which is drawn off `users.admissionsReviewer`; the round's own arrays are
 * what actually let them see it, and they may write nothing here. The review
 * queue itself is a separate surface.
 */
function ReviewerSummary({ round, stages }: { round: Round; stages: Stage[] }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>You are on this round</h2>
        <p className={styles.sectionNote}>
          You have been appointed to review or decide this round. Authoring is
          done by admins; the review queue opens once applications are in.
        </p>
      </div>
      <dl className={styles.definitionList}>
        <dt>Status</dt>
        <dd>{ADMISSION_ROUND_STATUS_LABEL[round.status]}</dd>
        <dt>Closes</dt>
        <dd>{round.closesAt ? round.closesAt.toLocaleString("en-GB") : "Not set"}</dd>
        <dt>Decisions by</dt>
        <dd>{round.decisionsByDate ?? "Not set"}</dd>
        <dt>Stages</dt>
        <dd>
          {stages.length} ({stages.reduce((n, s) => n + s.questionCount, 0)} questions)
        </dd>
        <dt>Criteria</dt>
        <dd>{round.criteria.map((c) => c.label).join(", ") || "None set"}</dd>
      </dl>
    </section>
  );
}

type PatchFn = (fields: Record<string, unknown>) => Promise<void>;

function DetailsSection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [label, setLabel] = useState(round.label);
  const [slug, setSlug] = useState(round.slug);
  const [academicYear, setAcademicYear] = useState(round.academicYear);
  const [blurb, setBlurb] = useState(round.blurb);

  return (
    <SectionCard
      id="details"
      title="Details"
      note="The name is for staff; the standfirst is what an applicant reads at the top of the form."
      onSave={() => patch({ label, slug, academicYear, blurb })}
    >
      <div className={styles.grid2}>
        <Field
          id="round-name"
          label="Name"
          hint="Staff-facing, but a slug of it becomes the round's id and shows in the public apply link"
        >
          <Input
            id="round-name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={L.label}
          />
        </Field>
        <Field id="round-slug" label="Url segment" hint="Lowercase letters, numbers and hyphens">
          <Input
            id="round-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            maxLength={L.slug}
          />
        </Field>
      </div>
      <Field id="round-year" label="Academic year" hint="Looks like 2026/27">
        <Input
          id="round-year"
          value={academicYear}
          onChange={(e) => setAcademicYear(e.target.value)}
          maxLength={L.academicYear}
        />
      </Field>
      <Field id="round-blurb" label="Standfirst">
        <CountedTextarea
          id="round-blurb"
          value={blurb}
          max={L.blurb}
          rows={4}
          onChange={(e) => setBlurb(e.target.value)}
        />
      </Field>
    </SectionCard>
  );
}

function WindowSection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [opensAt, setOpensAt] = useState<Date | null>(round.opensAt);
  const [closesAt, setClosesAt] = useState<Date | null>(round.closesAt);
  const [decisionsByDate, setDecisionsByDate] = useState(round.decisionsByDate ?? "");

  return (
    <SectionCard
      id="window"
      title="Window"
      note="The site opens and closes the form from these dates, and shows them publicly. Both bounds are inclusive, so a deadline of 23:59 accepts an application sent at 23:59."
      onSave={() =>
        patch({
          opensAt: opensAt ? opensAt.toISOString() : null,
          closesAt: closesAt ? closesAt.toISOString() : null,
          decisionsByDate: decisionsByDate || null,
        })
      }
    >
      <div className={styles.grid3}>
        <Field id="round-opens" label="Opens">
          <DateTimePopover
            value={opensAt}
            onChange={setOpensAt}
            placeholder="Not set"
          />
        </Field>
        <Field id="round-closes" label="Deadline">
          <DateTimePopover
            value={closesAt}
            onChange={setClosesAt}
            placeholder="Not set"
          />
        </Field>
        <Field
          id="round-decisions"
          label="Decisions by"
          hint="Shown to applicants"
        >
          <Input
            id="round-decisions"
            type="date"
            value={decisionsByDate}
            onChange={(e) => setDecisionsByDate(e.target.value)}
          />
        </Field>
      </div>
    </SectionCard>
  );
}

function RunPicker({
  runs,
  selected,
  onChange,
  cap,
}: {
  runs: CourseRunDoc[];
  selected: string[];
  onChange: (next: string[]) => void;
  cap: number;
}) {
  if (runs.length === 0) {
    return <p className={styles.hint}>No course runs found.</p>;
  }
  return (
    <div className={styles.checkList}>
      {runs.map((run) => {
        const checked = selected.includes(run.id);
        return (
          <label key={run.id} className={styles.check}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter((id) => id !== run.id)
                    : selected.length >= cap
                      ? selected
                      : [...selected, run.id],
                )
              }
            />
            <span>
              {run.label}{" "}
              <span className={styles.checkMeta}>
                {run.status}
                {run.streams.length > 0
                  ? ` · ${run.streams.length} stream${run.streams.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function OutcomesSection({
  round,
  runs,
  patch,
}: {
  round: Round;
  runs: CourseRunDoc[];
  patch: PatchFn;
}) {
  const [outcomeRunIds, setOutcomeRunIds] = useState(round.outcomeRunIds);
  const [evidenceRunIds, setEvidenceRunIds] = useState(round.evidenceRunIds);
  const appointment = round.kind === "appointment";

  return (
    <SectionCard
      id="outcomes"
      title={appointment ? "Evidence" : "Outcomes and evidence"}
      note={
        appointment
          ? "An appointment round places nobody on a run, so it has no outcome runs. Evidence runs still apply: a facilitator applicant's attendance on the pre-course is worth seeing."
          : "Outcome runs are the courses this round can offer places on. Evidence runs are the ones whose attendance and submissions reviewers should see alongside an application."
      }
      /* The outcome half is not merely hidden on an appointment round, it is
         left out of the body of the save. The PATCH route refuses a non-empty
         `outcomeRunIds` on this kind, and sending the field anyway would put a
         refusal one bad document away from a section whose visible controls
         are all evidence runs. */
      onSave={() =>
        patch(appointment ? { evidenceRunIds } : { outcomeRunIds, evidenceRunIds })
      }
    >
      {!appointment && (
        <Field id="outcome-runs" label="Outcome runs">
          <RunPicker
            runs={runs}
            selected={outcomeRunIds}
            onChange={setOutcomeRunIds}
            cap={L.maxOutcomeRuns}
          />
        </Field>
      )}
      <Field id="evidence-runs" label="Evidence runs">
        <RunPicker
          runs={runs}
          selected={evidenceRunIds}
          onChange={setEvidenceRunIds}
          cap={L.maxEvidenceRuns}
        />
      </Field>
    </SectionCard>
  );
}

/**
 * What stands where the programme section would be on an appointment round.
 *
 * A note rather than nothing. The section is absent by design, and an author
 * who has just met the kind selector has no way to tell a deliberate omission
 * from a page that failed to render half of itself. It carries the same `id`
 * as the real section so an old anchor still lands somewhere that explains
 * itself, and it has no save because there is nothing here to write.
 */
function AppointmentProgrammeNote() {
  return (
    <SectionCard
      id="programme"
      title="Programme preference"
      note="An appointment round asks nothing about programme choice: an applicant is offering to run a group, not choosing which one to take. The form leaves this section out, and the server refuses to store a preference on a round of this kind."
    >
      <p className={styles.hint}>
        Nothing to set here. Create an enrolment round if you need applicants to
        pick a stream or rank fellowships.
      </p>
    </SectionCard>
  );
}

function ProgrammeSection({
  round,
  runs,
  patch,
}: {
  round: Round;
  runs: CourseRunDoc[];
  patch: PatchFn;
}) {
  const [preference, setPreference] = useState(round.programmePreference);
  const [copyFromRunId, setCopyFromRunId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const outcomeRuns = useMemo(
    () => runs.filter((run) => round.outcomeRunIds.includes(run.id)),
    [runs, round.outcomeRunIds],
  );

  function update(fields: Partial<typeof preference>) {
    setPreference({ ...preference, ...fields });
  }

  function copyStreams() {
    const run = outcomeRuns.find((r) => r.id === copyFromRunId);
    if (!run) return;
    update({
      streams: run.streams
        .slice(0, L.maxProgrammeOptions)
        .map((s) => ({ id: s.id, label: s.label })),
    });
  }

  function toggleFellowship(run: CourseRunDoc) {
    const has = preference.fellowships.some((f) => f.id === run.id);
    update({
      fellowships: has
        ? preference.fellowships.filter((f) => f.id !== run.id)
        : [...preference.fellowships, { id: run.id, label: run.label }].slice(
            0,
            L.maxProgrammeOptions,
          ),
    });
  }

  async function save(force = false): Promise<boolean> {
    setError(null);
    try {
      await patch({ programmePreference: preference, ...(force ? { force: true } : {}) });
      setConfirmOpen(false);
      setTyped("");
      return true;
    } catch (err) {
      if (err instanceof RoundApiError && err.needsConfirmation) {
        setConfirmOpen(true);
        setError(err.message);
        return false;
      }
      throw err;
    }
  }

  return (
    <SectionCard
      id="programme"
      title="Programme preference"
      note="One round can feed several programmes: an applicant picks an incubator stream, ranks fellowships, or does both, so an incubator reject can be offered a fellowship place without applying again."
      onSave={() => save(false)}
    >
      <Switch
        checked={preference.enabled}
        onChange={(enabled) => update({ enabled })}
        label="Ask about programme choice"
        description="Off means this round asks nothing about which programme somebody wants."
      />

      <Field id="stream-copy" label="Incubator streams">
        <div className={styles.optionRow}>
          <Select
            id="stream-copy"
            value={copyFromRunId}
            onChange={(e) => setCopyFromRunId(e.target.value)}
          >
            <option value="">Copy streams from a run…</option>
            {outcomeRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            onClick={copyStreams}
            disabled={!copyFromRunId}
          >
            Copy
          </Button>
        </div>
      </Field>

      <ul className={styles.rowList}>
        {preference.streams.map((stream, index) => (
          <li key={stream.id} className={styles.optionRow}>
            <Field id={`stream-${stream.id}`} label={`Stream ${index + 1}`}>
              <Input
                id={`stream-${stream.id}`}
                value={stream.label}
                maxLength={L.programmeOptionLabel}
                onChange={(e) => {
                  const next = preference.streams.slice();
                  next[index] = { ...stream, label: e.target.value };
                  update({ streams: next });
                }}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                update({ streams: preference.streams.filter((s) => s.id !== stream.id) })
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="secondary"
        disabled={preference.streams.length >= L.maxProgrammeOptions}
        onClick={() =>
          update({
            streams: [...preference.streams, { id: newId("stream"), label: "" }],
          })
        }
      >
        Add a stream
      </Button>

      <Field id="fellowships" label="Fellowships">
        {outcomeRuns.length === 0 ? (
          <p className={styles.hint}>
            Pick this round&apos;s outcome runs first: a fellowship choice IS a run,
            so the decide route can offer a place without a second lookup table.
          </p>
        ) : (
          <div className={styles.checkList}>
            {outcomeRuns.map((run) => (
              <label key={run.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={preference.fellowships.some((f) => f.id === run.id)}
                  onChange={() => toggleFellowship(run)}
                />
                <span>{run.label}</span>
              </label>
            ))}
          </div>
        )}
      </Field>

      <div className={styles.grid2}>
        <Field id="max-ranked" label="Fellowships an applicant may rank">
          <Input
            id="max-ranked"
            type="number"
            min={1}
            max={L.maxProgrammeOptions}
            value={preference.maxRankedFellowships}
            onChange={(e) =>
              update({ maxRankedFellowships: Number(e.target.value) || 1 })
            }
          />
        </Field>
        <Switch
          checked={preference.offerFellowshipFallback}
          onChange={(offerFellowshipFallback) => update({ offerFellowshipFallback })}
          label="Ask about a fellowship fallback"
          description="Would you take a fellowship place if we cannot offer the incubator?"
        />
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        ariaLabel="Confirm a change to a live round"
        width="sm"
      >
        <div className={styles.confirmBody}>
          <h2 className={styles.confirmTitle}>People have already applied</h2>
          <p className={styles.sectionNote}>{error}</p>
          <Field
            id="confirm-programme"
            label={'Type "change" to save it anyway'}
          >
            <Input
              id="confirm-programme"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="danger"
              disabled={typed.trim().toLowerCase() !== "change"}
              onClick={() => void save(true)}
            >
              Save the change
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Leave it as it is
            </Button>
          </div>
        </div>
      </Modal>
    </SectionCard>
  );
}

function AvailabilitySection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [start, setStart] = useState(minutesToClock(round.availabilityGrid.startMinute));
  const [end, setEnd] = useState(minutesToClock(round.availabilityGrid.endMinute));
  const [slotMinutes, setSlotMinutes] = useState(round.availabilityGrid.slotMinutes);

  return (
    <SectionCard
      id="availability"
      title="Availability grid"
      note="The in-person availability question: seven days, drawn between these hours. Every answer stores the geometry it was drawn on, so widening this later cannot shift an answer somebody already gave."
      onSave={() =>
        patch({
          availabilityGrid: {
            version: round.availabilityGrid.version,
            startMinute: clockToMinutes(start, round.availabilityGrid.startMinute),
            endMinute: clockToMinutes(end, round.availabilityGrid.endMinute),
            slotMinutes,
          },
        })
      }
    >
      <div className={styles.grid3}>
        <Field id="grid-start" label="From">
          <Input
            id="grid-start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field id="grid-end" label="To">
          <Input
            id="grid-end"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
        <Field id="grid-slot" label="Slot length">
          <Select
            id="grid-slot"
            value={String(slotMinutes)}
            onChange={(e) => setSlotMinutes(Number(e.target.value))}
          >
            {[10, 15, 20, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </SectionCard>
  );
}

function AccessSection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [prompt, setPrompt] = useState(round.accessRequirementsPrompt);
  return (
    <SectionCard
      id="access"
      title="Access requirements"
      note="The answer to this is stored apart from the application and is never scored, never shown to a reviewer, and never part of the payload a decision is made from."
      onSave={() => patch({ accessRequirementsPrompt: prompt })}
    >
      <Field id="access-prompt" label="How the question is worded">
        <CountedTextarea
          id="access-prompt"
          value={prompt}
          max={L.accessRequirementsPrompt}
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
    </SectionCard>
  );
}

function CriteriaSection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [criteria, setCriteria] = useState<AdmissionCriterion[]>(round.criteria);
  const [scoreMin, setScoreMin] = useState(round.scoreScale.min);
  const [scoreMax, setScoreMax] = useState(round.scoreScale.max);
  const [perApplication, setPerApplication] = useState(round.reviewersPerApplication);
  const [hideNames, setHideNames] = useState(round.blind.hideNames);
  const [hideMembership, setHideMembership] = useState(round.blind.hideMembership);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  function update(index: number, fields: Partial<AdmissionCriterion>) {
    const next = criteria.slice();
    next[index] = { ...next[index], ...fields };
    setCriteria(next);
  }

  async function save(force = false): Promise<boolean> {
    setError(null);
    try {
      await patch({
        criteria,
        scoreScale: { min: scoreMin, max: scoreMax },
        reviewersPerApplication: perApplication,
        blind: { hideNames, hideMembership },
        ...(force ? { force: true } : {}),
      });
      setConfirmOpen(false);
      setTyped("");
      return true;
    } catch (err) {
      if (err instanceof RoundApiError && err.needsConfirmation) {
        setConfirmOpen(true);
        setError(err.message);
        return false;
      }
      throw err;
    }
  }

  return (
    <SectionCard
      id="criteria"
      title="Criteria and scoring"
      note="Reviewers score every application against these. A review's scores are keyed on the criterion id, so renaming one relabels decisions already made and removing one orphans its scores."
      onSave={() => save(false)}
    >
      <ul className={styles.rowList}>
        {criteria.map((criterion, index) => (
          <li key={criterion.id} className={styles.row}>
            <Field id={`criterion-${criterion.id}`} label={`Criterion ${index + 1}`}>
              <Input
                id={`criterion-${criterion.id}`}
                value={criterion.label}
                maxLength={L.criterionLabel}
                onChange={(e) => update(index, { label: e.target.value })}
              />
            </Field>
            <Field id={`criterion-${criterion.id}-guidance`} label="What to look for">
              <Input
                id={`criterion-${criterion.id}-guidance`}
                value={criterion.guidance}
                maxLength={L.criterionGuidance}
                onChange={(e) => update(index, { guidance: e.target.value })}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCriteria(criteria.filter((c) => c.id !== criterion.id))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="secondary"
        disabled={criteria.length >= L.maxCriteria}
        onClick={() =>
          setCriteria([...criteria, { id: newId("crit"), label: "", guidance: "" }])
        }
      >
        Add a criterion
      </Button>

      <div className={styles.grid3}>
        <Field id="score-min" label="Lowest score">
          <Input
            id="score-min"
            type="number"
            min={L.minScore}
            max={L.maxScore}
            value={scoreMin}
            onChange={(e) => setScoreMin(Number(e.target.value))}
          />
        </Field>
        <Field id="score-max" label="Highest score">
          <Input
            id="score-max"
            type="number"
            min={L.minScore}
            max={L.maxScore}
            value={scoreMax}
            onChange={(e) => setScoreMax(Number(e.target.value))}
          />
        </Field>
        <Field id="per-application" label="Reviewers per application">
          <Input
            id="per-application"
            type="number"
            min={1}
            max={L.maxReviewers}
            value={perApplication}
            onChange={(e) => setPerApplication(Number(e.target.value))}
          />
        </Field>
      </div>

      <Switch
        checked={hideNames}
        onChange={setHideNames}
        label="Hide applicant names from reviewers"
        description="Admins and the final decider are never blind."
      />
      <Switch
        checked={hideMembership}
        onChange={setHideMembership}
        label="Hide the paid-membership badge from reviewers"
        description="Membership must not affect the decision, and a reviewer who can see it cannot prove to themselves that it did not."
      />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        ariaLabel="Confirm a change to a live round"
        width="sm"
      >
        <div className={styles.confirmBody}>
          <h2 className={styles.confirmTitle}>People have already applied</h2>
          <p className={styles.sectionNote}>{error}</p>
          <Field id="confirm-criteria" label={'Type "change" to save it anyway'}>
            <Input
              id="confirm-criteria"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="danger"
              disabled={typed.trim().toLowerCase() !== "change"}
              onClick={() => void save(true)}
            >
              Save the change
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Leave it as it is
            </Button>
          </div>
        </div>
      </Modal>
    </SectionCard>
  );
}

/**
 * Reviewers and the final decider.
 *
 * The picker is a CHILD, mounted only for an admin, and that is the whole
 * point of the split: `useMembers` reads the `users` collection, which is
 * readable by admins and SU-recognised committee only. An `approveCourse`
 * holder authoring their own round is neither, so a hook called from the
 * shared component would fire a denied query on every load of the page and
 * leave a permission error in their console for a section they cannot use.
 */
function RolesSection({
  round,
  isAdmin,
  onSaved,
}: {
  round: Round;
  isAdmin: boolean;
  onSaved: (round: Round) => void;
}) {
  if (!isAdmin) {
    return (
      <SectionCard
        id="roles"
        title="Reviewers and final decider"
        note="Only an admin can appoint reviewers: membership of that list is what grants access to applications."
      >
        <dl className={styles.definitionList}>
          <dt>Reviewers</dt>
          <dd>{round.reviewerUids.length} appointed</dd>
          <dt>Final decider</dt>
          <dd>{round.finalDeciderUid ? "Appointed" : "Not appointed"}</dd>
        </dl>
      </SectionCard>
    );
  }

  return <RolesEditor round={round} onSaved={onSaved} />;
}

function RolesEditor({
  round,
  onSaved,
}: {
  round: Round;
  onSaved: (round: Round) => void;
}) {
  const { users, loading } = useMembers();
  const [reviewerUids, setReviewerUids] = useState(round.reviewerUids);
  const [finalDeciderUid, setFinalDeciderUid] = useState(round.finalDeciderUid ?? "");

  const eligible = useMemo(
    () =>
      users.filter(
        (u) => u.role === "admin" || (u.role === "committee" && u.suRecognised),
      ),
    [users],
  );

  /**
   * Anybody the member list no longer has is DERIVED out, not edited out.
   *
   * A round outlives the accounts named on it, and a deleted uid sitting in
   * `reviewerUids` is a name this picker cannot draw and the roles route
   * refuses to save, so the section would be stuck: no way to see who the
   * problem is, and no way to take them off either. Pruning makes the fix the
   * same Save the admin was already pressing, and the note below says it
   * happened.
   *
   * Derived rather than an effect that rewrites state: this has to hold for
   * whatever is selected right now, and a render that computes it cannot fall
   * out of step with one that does not.
   */
  const known = useMemo(() => new Set(users.map((u) => u.uid)), [users]);
  const membersLoaded = !loading && users.length > 0;
  const shownReviewers = membersLoaded
    ? reviewerUids.filter((uid) => known.has(uid))
    : reviewerUids;
  const shownDecider =
    membersLoaded && finalDeciderUid && !known.has(finalDeciderUid)
      ? ""
      : finalDeciderUid;
  const dropped =
    reviewerUids.length - shownReviewers.length + (finalDeciderUid && !shownDecider ? 1 : 0);

  return (
    <SectionCard
      id="roles"
      title="Reviewers and final decider"
      note="Reviewers have to be admins or SU-recognised committee, because they read applications. The final decider sees the aggregates with names and presses decide."
      onSave={async () => {
        onSaved(
          await setRoundRoles(round.id, {
            reviewerUids: shownReviewers,
            finalDeciderUid: shownDecider || null,
          }),
        );
      }}
    >
      {dropped > 0 && (
        <p className={styles.hint}>
          {dropped === 1 ? "One person" : `${dropped} people`} named on this round
          no longer {dropped === 1 ? "has an account" : "have accounts"} on the
          site. They have been taken off the list below; save to record it.
        </p>
      )}
      <PersonSelector
        users={eligible}
        selected={shownReviewers}
        onChange={setReviewerUids}
        label="Reviewers"
        role="reviewer"
        max={L.maxReviewers}
      />
      <Field
        id="final-decider"
        label="Final decider"
        hint="Never blind, and the only person who can press decide."
      >
        <Select
          id="final-decider"
          value={shownDecider}
          onChange={(e) => setFinalDeciderUid(e.target.value)}
        >
          <option value="">Nobody yet</option>
          {eligible.map((u) => (
            <option key={u.uid} value={u.uid}>
              {u.displayName ?? u.email ?? u.uid}
            </option>
          ))}
        </Select>
      </Field>
    </SectionCard>
  );
}

/**
 * The reminder schedule: a free list of slots, edited by the SHARED editor the
 * worksheet circulations use.
 *
 * It used to be three fixed rows wearing three fixed names ("A week out",
 * "Three days out", "Deadline day") over an editable number of days, which
 * made a row that said one thing and sent another as soon as anybody edited
 * it, and gave a round wanting a fourth nudge nowhere to put it. Every label
 * is now written from the numbers, so a row cannot be wrong about itself.
 *
 * The save is unchanged: the whole list goes up as `reminderOffsets`, which is
 * still the field name on the document.
 *
 * Save is held shut while the list has anything wrong with it, from the SAME
 * validator the editor prints its sentences from and the SAME validator the
 * PATCH route refuses on. Without that, a half-typed time reads as a warning
 * under the rows and then again as a red server error over the button, which
 * tells the author twice and helps them once. It is also the contract the
 * shared editor is written to, and the worksheet circulation panel, the other
 * mount of the same component, already keeps it.
 */
function RemindersSection({ round, patch }: { round: Round; patch: PatchFn }) {
  const [slots, setSlots] = useState<ReminderSlot[]>(round.reminderOffsets);
  const slotProblems = validateSlots(slots);

  return (
    <SectionCard
      id="reminders"
      title="Deadline reminders"
      note="Sent to anyone holding an unsubmitted draft. The scheduler keys each send on the resolved date, so editing this schedule cannot re-send a reminder that already went. An empty list means this round sends none."
      onSave={() => patch({ reminderOffsets: slots })}
      disabled={slotProblems.length > 0}
    >
      <SlotListEditor
        slots={slots}
        onChange={setSlots}
        anchorLabel="the closing date"
      />
      <SendRemindersNow roundId={round.id} disabled={round.status !== "open"} />
    </SectionCard>
  );
}

function StatusSection({
  round,
  patch,
  onChanged,
}: {
  round: Round;
  patch: PatchFn;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<AdmissionRoundStatus | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  /**
   * The archive toggle answers to the same busy and error handling as the
   * status buttons beside it: it is the same kind of write, and a save that
   * fails silently on a switch is worse than on a button, because the switch
   * has already moved and looks like it worked.
   *
   * The optimistic value is a pending override rather than a second copy of
   * `round.archived`. Clearing it is the reset: whether the patch succeeded
   * (the round came back changed) or failed (it did not), the switch goes back
   * to reading the round, so it can never end up showing a state the server
   * does not hold.
   */
  const [pendingArchive, setPendingArchive] = useState<boolean | null>(null);
  const archiving = pendingArchive !== null;

  async function setArchived(next: boolean) {
    setPendingArchive(next);
    setError(null);
    try {
      await patch({ archived: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save.");
    } finally {
      setPendingArchive(null);
    }
  }

  async function move(status: AdmissionRoundStatus, confirm = false) {
    setBusy(true);
    setError(null);
    try {
      await setRoundStatus(round.id, status, confirm);
      setPending(null);
      setTyped("");
      await onChanged();
    } catch (err) {
      if (err instanceof RoundApiError && err.needsConfirmation) {
        setPending(status);
        setPrompt(err.message);
      } else {
        setError(err instanceof Error ? err.message : "That did not change.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      id="status"
      title="Status"
      note="Draft is invisible to applicants. Opening it makes the form reachable, which is the one step that cannot be taken back quietly."
    >
      <div className={styles.statusRow} data-testid="round-status-controls">
        {nextStatuses(round.status).map((status) => {
          const plan = planStatusChange(round.status, status);
          return (
            <Button
              key={status}
              type="button"
              variant={status === "cancelled" ? "danger" : "secondary"}
              disabled={busy || archiving || !plan.ok}
              onClick={() => void move(status)}
            >
              {ADMISSION_ROUND_STATUS_LABEL[status]}
            </Button>
          );
        })}
        {nextStatuses(round.status).length === 0 && (
          <p className={styles.hint}>
            This round is finished. Nothing moves it again.
          </p>
        )}
      </div>

      <Switch
        checked={pendingArchive ?? round.archived}
        onChange={(next) => void setArchived(next)}
        disabled={busy || archiving}
        label="Archived"
        description="Keeps a finished round out of the way. An archived round cannot be opened."
      />

      {error && <p className={styles.error}>{error}</p>}

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        ariaLabel="Confirm the status change"
        width="sm"
      >
        <div className={styles.confirmBody}>
          <h2 className={styles.confirmTitle}>Reopen this round?</h2>
          <p className={styles.sectionNote}>{prompt}</p>
          <Field id="confirm-status" label={'Type "reopen" to confirm'}>
            <Input
              id="confirm-status"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="danger"
              disabled={typed.trim().toLowerCase() !== "reopen" || pending === null}
              onClick={() => pending && void move(pending, true)}
            >
              Reopen it
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPending(null)}>
              Leave it closed
            </Button>
          </div>
        </div>
      </Modal>
    </SectionCard>
  );
}
