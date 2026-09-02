"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { useAuth } from "@/auth/AuthProvider";
import type { GroupPickerOption } from "./fetchGroupPicker";
import type { EnrolStatePayload, MyEnrolmentSummary } from
  "@/app/api/courses/runs/[runId]/enrol/route";
import DropOutCard from "./DropOutCard";
import styles from "./GroupPicker.module.css";

/**
 * The open-enrolment sign-up: pick a weekly session slot, take a seat, and
 * later change it or leave.
 *
 * Rendered only for a run whose `enrolMode` is `open` and whose enrolment
 * window the SERVER says is open (`isEnrolOpen`). This component never decides
 * that for itself: the page passes the slots it fetched and the state it
 * computed, and every write is refused again on the server against a
 * re-read of the run inside the transaction.
 *
 * ── WHAT IT KNOWS AND WHAT IT ASKS FOR ──────────────────────────────────────
 * The slots arrive as props, rendered on the server with the page, so a
 * signed-out visitor sees the timetable without a round trip and without a
 * flash. The one thing the server render cannot carry is the caller's own
 * enrolment (the page is one cached-per-request render for every visitor),
 * so that comes from `GET .../enrol` on mount, and the same call refreshes
 * the seat counts after any write. Until it lands the component shows the
 * slots and a disabled action rather than guessing.
 *
 * ── SEAT COUNTS ARE ADVISORY ────────────────────────────────────────────────
 * `seatsLeft` is a number that was true when the page rendered. The enrol
 * transaction is the only thing that decides who gets the last place, so a
 * full card is disabled as a courtesy and a race still ends in a friendly 409
 * that is shown verbatim. Nothing here may promise a seat.
 */

export type GroupPickerStream = { id: string; label: string };

type Props = {
  runId: string;
  /** The course this run belongs to, for the drop-out confirmation ritual. */
  courseTitle: string;
  /** Session slots, projected server-side. See `fetchGroupPicker.ts`. */
  groups: GroupPickerOption[];
  /** The run's streams; empty when it has none. */
  streams: GroupPickerStream[];
  /** Where to send a signed-out visitor back to after sign-in. */
  nextPath: string;
};

const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/**
 * "18:00" + 90 -> "19:30". Wall-clock arithmetic for a display label only.
 *
 * Deliberately local rather than imported: the server-side twin lives in
 * `fetchCourses.ts`, which is `server-only`, and nothing about a weekday name
 * plus two zero-padded times is timezone-sensitive. Real instants come from
 * `londonWallClockToInstant()` in `lib/courses/weekPlan.ts`; nothing here
 * reasons about DST because nothing here reasons about a date.
 */
function endTimeLabel(start: string, minutes: number): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m || minutes <= 0) return null;
  const total = (Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function slotLabel(group: GroupPickerOption): string {
  const day = WEEKDAYS[group.weekday] ?? "";
  const end = endTimeLabel(group.startTimeLocal, group.durationMinutes);
  const time = end
    ? `${group.startTimeLocal} to ${end}`
    : group.startTimeLocal;
  return day ? `${day} ${time}` : time;
}

function seatsLabel(group: GroupPickerOption): string {
  if (group.full) return "Full";
  if (group.seatsLeft === null) return "Places available";
  if (group.seatsLeft === 1) return "1 place left";
  return `${group.seatsLeft} places left`;
}

export default function GroupPicker({
  runId,
  courseTitle,
  groups: initialGroups,
  streams,
  nextPath,
}: Props) {
  const { user, loading: authLoading } = useAuth();

  const [groups, setGroups] = useState<GroupPickerOption[]>(initialGroups);
  const [enrolment, setEnrolment] = useState<MyEnrolmentSummary | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [chosenGroupId, setChosenGroupId] = useState<string>("");
  const [chosenStreamId, setChosenStreamId] = useState<string>(
    streams[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  // The picker only ever reflects the latest response, so a slow first load
  // landing after a fast enrol must not overwrite it.
  const requestSeq = useRef(0);

  const loadState = useCallback(async () => {
    if (!user) return;
    const seq = ++requestSeq.current;
    try {
      const res = await fetch(
        `/api/courses/runs/${encodeURIComponent(runId)}/enrol`,
      );
      const body = (await res.json().catch(() => null)) as
        | (EnrolStatePayload & { error?: string })
        | null;
      if (seq !== requestSeq.current) return;
      if (!res.ok || !body || !Array.isArray(body.groups)) {
        // A read failure leaves the server-rendered slots in place: the page
        // still shows the timetable, and the first write will say what is
        // wrong in a sentence rather than a status code.
        return;
      }
      setGroups(body.groups);
      setEnrolment(body.enrolment);
      if (body.enrolment?.streamId) setChosenStreamId(body.enrolment.streamId);
    } catch {
      // Same reasoning: offline or a blip leaves the rendered slots alone.
    } finally {
      if (seq === requestSeq.current) setStateLoaded(true);
    }
  }, [runId, user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setStateLoaded(true);
      return;
    }
    void loadState();
  }, [authLoading, user, loadState]);

  const write = useCallback(
    async (method: "POST" | "PATCH", groupId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/courses/runs/${encodeURIComponent(runId)}/enrol`,
          {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              groupId,
              ...(streams.length > 0 ? { streamId: chosenStreamId } : {}),
            }),
          },
        );
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) {
          // The server's sentence, verbatim. Every refusal on that route is
          // written to be read by the person who hit it.
          setError(body?.error ?? "Couldn't save that just now.");
          // Re-read anyway: "that session is full" is a fact about the
          // timetable, and the numbers on screen are now known to be stale.
          await loadState();
          return;
        }
        setChanging(false);
        setChosenGroupId("");
        await loadState();
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [runId, streams.length, chosenStreamId, loadState],
  );

  // ---- Signed out -------------------------------------------------------
  if (!authLoading && !user) {
    return (
      <div className={styles.picker}>
        <SlotList groups={groups} />
        <Link
          href={`/login?next=${encodeURIComponent(nextPath)}`}
          className={styles.button}
        >
          Sign in to take a place
        </Link>
        <p className={styles.note}>
          You need a NAISI account to sign up. Making one takes a minute, and
          you can do it right now even if you have only just arrived.
        </p>
      </div>
    );
  }

  if (authLoading || !stateLoaded) {
    return (
      <div className={styles.picker}>
        <SlotList groups={groups} />
      </div>
    );
  }

  // ---- Already on the course -------------------------------------------
  if (enrolment && enrolment.status === "active") {
    const mine = groups.find((g) => g.id === enrolment.groupId);
    const streamLabel = streams.find((s) => s.id === enrolment.streamId)?.label;
    return (
      <div className={styles.picker}>
        <p className={styles.mine}>
          <span className={styles.tick} aria-hidden="true">
            &#10003;
          </span>{" "}
          {mine
            ? `You're in ${mine.name}, ${slotLabel(mine)}.`
            : "You're signed up. We'll email you your session details."}
          {streamLabel ? ` Strand: ${streamLabel}.` : ""}
        </p>

        {enrolment.role === "facilitator" ? (
          <p className={styles.note}>
            You&apos;re on this course as a facilitator, so your place is
            managed by the team.
          </p>
        ) : changing ? (
          <>
            <SlotList
              groups={groups}
              selectable
              currentId={enrolment.groupId}
              chosenId={chosenGroupId}
              onChoose={setChosenGroupId}
            />
            {streams.length > 0 ? (
              <StreamField
                streams={streams}
                value={chosenStreamId}
                onChange={setChosenStreamId}
              />
            ) : null}
            {error ? <p className={styles.error}>{error}</p> : null}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={busy || !chosenGroupId}
                onClick={() => void write("PATCH", chosenGroupId)}
              >
                {busy ? "Saving..." : "Move to this session"}
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => {
                  setChanging(false);
                  setChosenGroupId("");
                  setError(null);
                }}
              >
                Keep my session
              </button>
            </div>
          </>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setChanging(true)}
            >
              Change session
            </button>
          </div>
        )}

        {enrolment.role === "learner" ? (
          <DropOutCard
            runId={runId}
            courseTitle={courseTitle}
            onDropped={() => void loadState()}
          />
        ) : null}
      </div>
    );
  }

  // ---- Left already ------------------------------------------------------
  // Dropping out is irreversible by decision, and the route enforces it (the
  // enrolment row already exists at the deterministic id, so a second
  // `tx.create` cannot succeed). Saying so plainly beats offering a button
  // that would always fail.
  if (enrolment) {
    return (
      <div className={styles.picker}>
        <p className={styles.note}>
          You came off this course. Signing up again isn&apos;t something you
          can do here, but the team can put you back on: email us and say so.
        </p>
      </div>
    );
  }

  // ---- Not on it yet -----------------------------------------------------
  return (
    <div className={styles.picker}>
      <SlotList
        groups={groups}
        selectable
        chosenId={chosenGroupId}
        onChoose={setChosenGroupId}
      />
      {streams.length > 0 ? (
        <StreamField
          streams={streams}
          value={chosenStreamId}
          onChange={setChosenStreamId}
        />
      ) : null}
      {error ? <p className={styles.error}>{error}</p> : null}
      {groups.length > 0 ? (
        <button
          type="button"
          className={styles.button}
          disabled={busy || !chosenGroupId}
          onClick={() => void write("POST", chosenGroupId)}
        >
          {busy ? "Signing you up..." : "Take this place"}
        </button>
      ) : null}
    </div>
  );
}

function StreamField({
  streams,
  value,
  onChange,
}: {
  streams: GroupPickerStream[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className={styles.streamField}>
      <label className={styles.streamLabel} htmlFor="course-stream">
        Which strand?
      </label>
      <ResponsiveSelect
        id="course-stream"
        ariaLabel="Which strand?"
        value={value}
        onChange={onChange}
        options={streams.map((s) => ({ value: s.id, label: s.label }))}
      />
    </div>
  );
}

/**
 * The timetable. Radio-style cards rather than a select, because the choice is
 * the page's whole question and each option carries three facts (day, time,
 * how full it is) that a collapsed control would hide.
 */
function SlotList({
  groups,
  selectable,
  currentId,
  chosenId,
  onChoose,
}: {
  groups: GroupPickerOption[];
  selectable?: boolean;
  currentId?: string | null;
  chosenId?: string;
  onChoose?: (id: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <p className={styles.note}>
        The session times aren&apos;t up yet. Check back shortly, or subscribe
        and we&apos;ll tell you when they are.
      </p>
    );
  }
  if (!selectable) {
    return (
      <ul className={styles.slotList}>
        {groups.map((g) => (
          <li key={g.id} className={styles.slotStatic}>
            <span className={styles.slotName}>{g.name}</span>
            <span className={styles.slotWhen}>{slotLabel(g)}</span>
            <span className={styles.slotSeats}>{seatsLabel(g)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>Pick a session</legend>
      <div className={styles.slotList}>
        {groups.map((g) => {
          const isCurrent = currentId === g.id;
          // The session you are already in is never "full" to you: you are one
          // of the people filling it.
          const disabled = g.full && !isCurrent;
          return (
            <label
              key={g.id}
              className={[
                styles.slot,
                chosenId === g.id ? styles.slotChosen : "",
                disabled ? styles.slotDisabled : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <input
                type="radio"
                name="course-session"
                className={styles.radio}
                value={g.id}
                checked={chosenId === g.id}
                disabled={disabled}
                onChange={() => onChoose?.(g.id)}
              />
              <span className={styles.slotBody}>
                <span className={styles.slotName}>
                  {g.name}
                  {isCurrent ? (
                    <span className={styles.currentTag}>your session</span>
                  ) : null}
                </span>
                <span className={styles.slotWhen}>{slotLabel(g)}</span>
              </span>
              <span className={styles.slotSeats}>{seatsLabel(g)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
