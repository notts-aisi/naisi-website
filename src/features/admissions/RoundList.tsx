"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import {
  ADMISSION_ROUND_KINDS,
  ADMISSION_ROUND_KIND_LABEL,
  ADMISSION_ROUND_STATUS_LABEL,
  type AdmissionRoundKind,
  type AdmissionRoundStatus,
} from "@/lib/firestore/admissionRounds";
import { formatRoundDeadline } from "@/lib/admissions/window";
import { createRound, fetchRounds, type Round } from "./roundClient";
import styles from "./RoundList.module.css";

const STATUS_TONE: Record<AdmissionRoundStatus, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  open: "success",
  closed: "warning",
  deciding: "accent",
  settled: "neutral",
  cancelled: "danger",
};

/**
 * The admissions index: every round this caller may see, and the form that
 * makes a new one.
 *
 * The list is a ROUTE read, not a Firestore listener, because
 * `admissionRounds` is `allow read, write: if false` on both halves: the round
 * document carries live application counters and the name of the person who
 * decides each application, so a signed-in read would let any account watch a
 * competitive intake move. The route filters per caller, so this component
 * renders whatever it is given without a second opinion about visibility.
 */
export default function RoundList() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AdmissionRoundKind>("enrolment");
  const [academicYear, setAcademicYear] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  /**
   * ONE load, called by the mount effect and again after a round is created.
   * State moves only from the async callbacks, never synchronously in the
   * effect body: the same shape `useOneShotList` uses, and the reason this is
   * a promise chain rather than an awaited call.
   *
   * `isCancelled` is how the effect's cleanup reaches in, so the effect calls
   * this rather than carrying a second copy of the same six lines.
   */
  const load = useCallback(
    (isCancelled: () => boolean = () => false) =>
      fetchRounds()
        .then((data) => {
          if (isCancelled()) return;
          setRounds(data.rounds);
          setCanAuthor(data.canAuthor);
          setError(null);
        })
        .catch((err: unknown) => {
          if (isCancelled()) return;
          setError(err instanceof Error ? err.message : "Could not load the rounds.");
        })
        .finally(() => {
          if (!isCancelled()) setLoading(false);
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const { id } = await createRound({ label, kind, academicYear });
      setLabel("");
      setAcademicYear("");
      setCreatedId(id);
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create the round.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        A round is one intake: the questions people answer, the window they
        answer in, the criteria they are scored against and the runs they can be
        placed on. One round can feed several courses, so an incubator applicant
        can be offered a fellowship place without applying twice.
      </p>

      {canAuthor && (
        <Card as="section" padding="md">
          <h2 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-4)" }}>
            New round
          </h2>
          <form className={styles.createRow} onSubmit={submit}>
            <Field id="round-label" label="Name">
              <Input
                id="round-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Autumn 2026 intake"
                maxLength={80}
                required
              />
            </Field>
            <Field id="round-kind" label="What it decides">
              <Select
                id="round-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as AdmissionRoundKind)}
              >
                {ADMISSION_ROUND_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ADMISSION_ROUND_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="round-year" label="Academic year" hint="Optional">
              <Input
                id="round-year"
                value={academicYear}
                onChange={(e) => setAcademicYear(e.target.value)}
                placeholder="2026/27"
                maxLength={9}
              />
            </Field>
            <Button type="submit" disabled={creating || !label.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </form>
          {createError && <p className={styles.error}>{createError}</p>}
          {createdId && !createError && (
            <p className={styles.meta}>
              Created. <Link href={`/admin/admissions/${createdId}`}>Open it</Link> to
              set the dates and the questions.
            </p>
          )}
        </Card>
      )}

      {loading && <p className={styles.empty}>Loading rounds…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && rounds.length === 0 && (
        <p className={styles.empty}>
          {canAuthor
            ? "No rounds yet. Create one above."
            : "You are not on any round at the moment."}
        </p>
      )}

      <ul className={styles.list}>
        {rounds.map((round) => (
          <li key={round.id}>
            <Link href={`/admin/admissions/${round.id}`} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  <span className={styles.name}>{round.label}</span>
                  <Badge tone={STATUS_TONE[round.status]}>
                    {ADMISSION_ROUND_STATUS_LABEL[round.status]}
                  </Badge>
                  {round.archived && <Badge tone="neutral">Archived</Badge>}
                </span>
                <span className={styles.meta}>
                  {ADMISSION_ROUND_KIND_LABEL[round.kind]}
                  {round.academicYear ? ` · ${round.academicYear}` : ""}
                  {round.closesAt
                    ? ` · closes ${formatRoundDeadline(round.closesAt)}`
                    : " · no deadline set"}
                </span>
              </span>
              <span className={styles.counts}>
                {round.applicationCounts.submitted} submitted ·{" "}
                {round.applicationCounts.draft} in progress
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
