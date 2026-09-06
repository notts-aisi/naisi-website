"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import CountedTextarea from "@/components/ui/CountedTextarea";
import EmptyState from "@/components/ui/EmptyState";
import MemberText from "@/components/ui/MemberText";
import ProgressBar from "@/components/ui/ProgressBar";
import Skeleton from "@/components/ui/Skeleton";
import StarRating from "@/components/ui/StarRating";
import { MATERIAL_NOTE_LIMITS } from "@/lib/firestore/courseMaterialNotes";
import {
  RETRO_ANONYMITY_FLOOR,
  type MaterialRetroRow,
} from "@/lib/firestore/courseTemplates";
import { formatWireStamp, useRetrospective } from "./useTemplates";
import styles from "./RetrospectiveView.module.css";

/**
 * How the last delivery's curriculum actually landed — one row per material,
 * across the whole run.
 *
 * The point of the view is to be READ WHILE AUTHORING: someone drafting next
 * year's weeks wants to know which reading nobody finished and which one the
 * cohort rated top, and today that evidence is scattered across progress rows
 * nobody queries. So the shape is a table of materials in curriculum order, not
 * a dashboard.
 *
 * ── WHAT IS AND ISN'T A PERSON HERE ─────────────────────────────────────────
 * Ratings and completions are shown ONLY IN AGGREGATE. Nothing on this surface
 * carries a uid, and the payload never contained one: the route reduces
 * `courseProgress` to counts before it answers. The only names belong to
 * facilitators, writing notes in their staff capacity — which is why those are
 * attributed and the ratings are not.
 *
 * "In aggregate" is the whole claim, and the copy below says exactly that
 * rather than promising anonymity. The suppression floor is stated in the
 * header rather than left as a mystery blank: an average is withheld below
 * `RETRO_ANONYMITY_FLOOR` ratings, and the count is shown anyway so the reason
 * is legible. `useTemplates` re-applies the suppression on the way in, so a
 * route that forgot it still can't leak one here.
 *
 * The floor defeats a single read, NOT differencing across reloads — three
 * ratings averaging 4.0, refreshed into four averaging 4.25, gives up the
 * newcomer's 5 exactly. That limitation is accepted rather than engineered
 * around (see `RETRO_ANONYMITY_FLOOR` for why), which is precisely why this
 * surface must not tell a member their rating is anonymous.
 * ────────────────────────────────────────────────────────────────────────────
 */

type Props = { courseId: string; runId: string };

/** Stable per-row key. An itemId is unique per run, but the week pairs it safely. */
function rowKey(m: MaterialRetroRow): string {
  return `${m.weekNumber}:${m.itemId}`;
}

export default function RetrospectiveView({ courseId, runId }: Props) {
  const { data, loading, refreshing, error, reload, addNote } = useRetrospective(runId);

  // Per-material composer state, keyed by `rowKey`. One open composer at a
  // time: two half-written notes on one screen is a way to lose one of them.
  const [openComposer, setOpenComposer] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [noteErrors, setNoteErrors] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const runHref = `/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}`;

  async function submitNote(material: MaterialRetroRow) {
    const key = rowKey(material);
    const note = (drafts[key] ?? "").trim();
    if (!note) {
      setNoteErrors((e) => ({ ...e, [key]: "Write the note first." }));
      return;
    }
    setBusyKey(key);
    setNoteErrors((e) => ({ ...e, [key]: "" }));
    const result = await addNote({
      itemId: material.itemId,
      weekNumber: material.weekNumber,
      note,
    });
    setBusyKey(null);
    if (result.ok) {
      setDrafts((d) => ({ ...d, [key]: "" }));
      setOpenComposer(null);
    } else {
      setNoteErrors((e) => ({ ...e, [key]: result.error }));
    }
  }

  const materials = data?.materials ?? [];

  // Week sections, built from the payload's curriculum order. A plain reduce
  // rather than a Map+sort: the rows already arrive ordered, so the only job
  // left is to notice where the week number changes.
  const weeks: { weekNumber: number; rows: MaterialRetroRow[] }[] = [];
  for (const material of materials) {
    const last = weeks[weeks.length - 1];
    if (last && last.weekNumber === material.weekNumber) last.rows.push(material);
    else weeks.push({ weekNumber: material.weekNumber, rows: [material] });
  }

  return (
    <div className={styles.view}>
      <div className={styles.breadcrumb}>
        <Link href={runHref} className={styles.backLink}>
          ← Back to the run editor
        </Link>
      </div>

      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Retrospective</p>
          <h1 className={styles.title}>
            {data?.run?.label || "This run"}
            {data?.run?.courseTitle ? ` · ${data.run.courseTitle}` : ""}
          </h1>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      <p className={styles.lede}>
        How each piece of material landed with this cohort, in curriculum order.
        Ratings are shown only in aggregate — no row here says who rated what,
        and an average is withheld until at least {RETRO_ANONYMITY_FLOOR} people
        have rated the item (the count is still shown, so you can see why).
        Aggregate is not the same as anonymous: on a small cohort, comparing this
        page against an earlier look at it can still single a rating out.
        Facilitator notes are attributed: they are written by staff, for staff.
      </p>

      {error && (
        <p className={styles.error}>
          Couldn&apos;t load the retrospective: {error.message}
        </p>
      )}

      {data?.truncated && (
        <p className={styles.warn}>
          This run has more progress rows than one read can aggregate, so the
          figures below cover part of the cohort rather than all of it. Treat
          them as indicative, not final.
        </p>
      )}

      {loading && (
        <Card padding="lg">
          <Skeleton lines={6} height="2rem" ariaLabel="Loading the retrospective…" />
        </Card>
      )}

      {!loading && !error && materials.length === 0 && (
        <EmptyState
          title="No materials to look back on yet"
          body="Once this run has authored weeks with reading in them, every item shows up here with its ratings, completion and facilitator notes."
          action={
            <Link href={runHref}>
              <Button type="button" variant="secondary">
                Open the run editor
              </Button>
            </Link>
          }
        />
      )}

      {weeks.map((week) => (
        <Card key={week.weekNumber} padding="lg">
          <section className={styles.week}>
            <div className={styles.weekHead}>
              <h2 className={styles.weekTitle}>Week {week.weekNumber}</h2>
              <span className={styles.weekCount}>
                {week.rows.length} material{week.rows.length === 1 ? "" : "s"}
              </span>
            </div>

            <ul className={styles.materials}>
              {week.rows.map((material) => {
                const key = rowKey(material);
                const composing = openComposer === key;
                const busy = busyKey === key;
                const noteError = noteErrors[key];

                return (
                  <li key={key} className={styles.material}>
                    <div className={styles.materialHead}>
                      <h3 className={styles.materialTitle}>
                        {material.title || "(untitled material)"}
                      </h3>
                      {material.facilitatorNotes.length > 0 && (
                        <Chip size="sm" tone="neutral">
                          {material.facilitatorNotes.length} note
                          {material.facilitatorNotes.length === 1 ? "" : "s"}
                        </Chip>
                      )}
                    </div>

                    <div className={styles.figures}>
                      {/* --- Ratings --- */}
                      <div className={styles.figure}>
                        <span className={styles.figureLabel}>Rating</span>
                        {material.ratingCount === 0 ? (
                          <span className={styles.quiet}>Nobody rated this</span>
                        ) : material.avgRating === null ? (
                          <span className={styles.quiet}>
                            Ratings hidden below {RETRO_ANONYMITY_FLOOR} responses
                            {" — "}
                            {material.ratingCount} so far
                          </span>
                        ) : (
                          <span className={styles.ratingRow}>
                            {/* Half-star display: a cohort average is 4.5 as
                                often as it is 4, and rounding it to an integer
                                would report a number nobody gave. */}
                            <StarRating
                              value={material.avgRating}
                              readOnly
                              precision="half"
                              size="sm"
                              ariaLabel={`Average rating for ${material.title || "this material"}`}
                            />
                            <span className={styles.figureValue}>
                              {material.avgRating.toFixed(1)}
                            </span>
                            <span className={styles.quiet}>
                              {material.ratingCount} rating
                              {material.ratingCount === 1 ? "" : "s"}
                            </span>
                          </span>
                        )}
                      </div>

                      {/* --- Completion --- */}
                      <div className={styles.figure}>
                        <span className={styles.figureLabel}>Completion</span>
                        {material.enrolledCount === 0 ? (
                          <span className={styles.quiet}>Nobody is enrolled on this run</span>
                        ) : (
                          <>
                            <ProgressBar
                              value={material.completedCount}
                              max={material.enrolledCount}
                              size="sm"
                              tone="accent"
                              ariaLabel={`Completion for ${material.title || "this material"}`}
                            />
                            <span className={styles.quiet}>
                              {material.completedCount} of {material.enrolledCount} checked
                              it off
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {material.facilitatorNotes.length > 0 && (
                      <ul className={styles.notes}>
                        {material.facilitatorNotes.map((note, i) => (
                          <li
                            // Notes carry no id over the wire and one
                            // facilitator has at most one note per material, so
                            // author + instant is the stable pair; the index
                            // only breaks a tie that shouldn't exist.
                            key={`${note.byName}-${note.at ?? i}`}
                            className={styles.note}
                          >
                            <p className={styles.noteMeta}>
                              {note.byName || "NAISI facilitator"}
                              {note.at ? ` · ${formatWireStamp(note.at)}` : ""}
                            </p>
                            <MemberText text={note.note} />
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* --- Composer ---
                        Open on request rather than always: a page of thirty
                        textareas reads as a form to fill in, and this is a
                        reading surface first. The route is the boundary on who
                        may write — facilitators of any group on the run, track
                        leads and admins — so a refusal lands inline below. */}
                    {composing ? (
                      <div className={styles.composer}>
                        <CountedTextarea
                          value={drafts[key] ?? ""}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [key]: e.target.value }))
                          }
                          max={MATERIAL_NOTE_LIMITS.note}
                          rows={3}
                          disabled={busy}
                          aria-label={`Note on ${material.title || "this material"}`}
                          placeholder="How did this land? What would you change?"
                        />
                        {noteError && <p className={styles.noteError}>{noteError}</p>}
                        <div className={styles.composerActions}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpenComposer(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => submitNote(material)}
                            disabled={busy}
                          >
                            {busy ? "Saving…" : "Save note"}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className={styles.composerActions}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setOpenComposer(key);
                            setNoteErrors((e) => ({ ...e, [key]: "" }));
                          }}
                        >
                          Add a note
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </Card>
      ))}
    </div>
  );
}
