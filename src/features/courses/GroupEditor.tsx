"use client";

import { useId, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import { Field, Input } from "@/components/ui/Input";
import PersonSelector from "@/components/ui/PersonSelector";
import Switch from "@/components/ui/Switch";
import type { UserDoc } from "@/lib/firestore/users";
import {
  validateSubmissionUrl,
  type CourseEnrolMode,
} from "@/lib/firestore/courses";
import {
  GROUP_FIELD_LIMITS,
  MAX_OPEN_MODE_CAPACITY,
  groupCapacityError,
  type CourseGroupDoc,
  type GroupSession,
} from "@/lib/firestore/courseGroups";
import {
  createGroup,
  setGroupArchived,
  setGroupFacilitators,
  updateGroup,
} from "./courseMutations";
import SessionSlotField from "./SessionSlotField";
import styles from "./GroupEditor.module.css";

/**
 * One group's card in the run editor, plus the inline "new group" form.
 *
 * Two write paths, deliberately: the content fields (name, capacity, session)
 * go client-direct through `updateGroup` because the rules express that
 * invariant exactly, while `facilitatorUids` is server-owned and pinned in
 * rules — assigning a facilitator also upserts a `role:"facilitator"`
 * enrolment, which no client write can do. The card saves both in one gesture
 * and lets the toast report whichever half fails.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

/** A sensible first slot for a brand-new group: Tuesday evening, 90 minutes. */
const DEFAULT_SESSION: GroupSession = {
  weekday: 2,
  startTimeLocal: "18:00",
  durationMinutes: 90,
  location: "",
  meetingUrl: null,
  notes: "",
};

/**
 * What "capacity" means differs by run, so the hint does too. An admissions
 * run is placed by a human who can see the size of each group, so a blank cap
 * is legitimate; an open run fills itself, and a group that fills past the
 * register ceiling makes bulk marking fail for everybody in it.
 */
const CAPACITY_HINT: Record<CourseEnrolMode, string> = {
  admissions: "Leave blank for no cap.",
  open: `Required on an open-enrolment run, at most ${MAX_OPEN_MODE_CAPACITY}.`,
};

function sameUids(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((uid, i) => uid === b[i]);
}

/** "" → null, and never `undefined` — Firestore rejects it outright. */
function capacityFromInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

type Props = {
  group: CourseGroupDoc;
  members: UserDoc[];
  /**
   * The PARENT RUN's enrolment mode. Not on the group document and it cannot
   * be: the capacity rule is a two-document rule, and this component is the
   * only place that already holds both halves. See `groupCapacityError`.
   */
  enrolMode: CourseEnrolMode;
  runAction: ToastRun;
  onSaved: () => void;
  disabled?: boolean;
};

export default function GroupEditor({
  group,
  members,
  enrolMode,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const fieldId = useId();

  const [name, setName] = useState(group.name);
  const [capacity, setCapacity] = useState(
    group.capacity === null ? "" : String(group.capacity),
  );
  const [session, setSession] = useState<GroupSession>(group.session);
  const [facilitatorUids, setFacilitatorUids] = useState<string[]>(
    group.facilitatorUids,
  );
  const [error, setError] = useState<string | null>(null);
  const [syncedGroup, setSyncedGroup] = useState<CourseGroupDoc>(group);

  // Reseed from the saved doc whenever it changes identity (a reload after a
  // save). Adjusted during render rather than in an effect, per the React docs
  // and TimeField's precedent. One-shot reads, so there is no listener to race
  // a live edit.
  if (group !== syncedGroup) {
    setSyncedGroup(group);
    setName(group.name);
    setCapacity(group.capacity === null ? "" : String(group.capacity));
    setSession(group.session);
    setFacilitatorUids(group.facilitatorUids);
    setError(null);
  }

  const meetingUrlValue = session.meetingUrl ?? "";

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give the group a name.");
      return;
    }
    const url = meetingUrlValue.trim();
    if (url) {
      const urlError = validateSubmissionUrl(url, GROUP_FIELD_LIMITS.meetingUrl);
      if (urlError) {
        setError(urlError);
        return;
      }
    }
    // Checked here so an open-mode group missing its capacity reads a sentence
    // instead of a permission-denied: firestore.rules refuses this exact write
    // and has no way to say why.
    const nextCapacity = capacityFromInput(capacity);
    const capacityError = groupCapacityError(nextCapacity, enrolMode);
    if (capacityError) {
      setError(capacityError);
      return;
    }
    setError(null);

    const nextSession: GroupSession = {
      ...session,
      location: session.location.trim(),
      // Empty stays null rather than "" — `meetingUrl` is nullable by design
      // and the group card renders "in person only" off exactly that null.
      meetingUrl: url ? url : null,
      notes: session.notes.trim(),
    };
    const facilitatorsChanged = !sameUids(facilitatorUids, group.facilitatorUids);

    let ok = false;
    await runAction(
      async () => {
        await updateGroup(
          group.id,
          {
            name: trimmedName,
            capacity: nextCapacity,
            session: nextSession,
          },
          enrolMode,
        );
        if (facilitatorsChanged) {
          await setGroupFacilitators(group.id, facilitatorUids);
        }
        ok = true;
      },
      {
        savingMessage: "Saving group…",
        successMessage: "Group saved",
      },
    );
    if (ok) onSaved();
  }

  async function toggleArchived(next: boolean) {
    let ok = false;
    await runAction(
      async () => {
        await setGroupArchived(group.id, next);
        ok = true;
      },
      {
        savingMessage: next ? "Archiving group…" : "Restoring group…",
        successMessage: next ? "Group archived" : "Group restored",
      },
    );
    if (ok) onSaved();
  }

  return (
    <Card padding="md" className={group.archived ? styles.archivedCard : undefined}>
      <div className={styles.header}>
        <h4 className={styles.groupName}>{group.name || "Untitled group"}</h4>
        <div className={styles.headerMeta}>
          {group.archived && <Badge tone="neutral">Archived</Badge>}
          <Badge tone={group.memberCount > 0 ? "accent" : "neutral"}>
            {group.memberCount}
            {group.capacity !== null ? `/${group.capacity}` : ""} placed
          </Badge>
        </div>
      </div>

      <div className={styles.fields}>
        <div className={styles.twoCol}>
          <Field id={`${fieldId}-name`} label="Group name">
            <Input
              id={`${fieldId}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={GROUP_FIELD_LIMITS.name}
              disabled={disabled}
              placeholder="e.g. Tuesday evening"
            />
          </Field>
          <Field
            id={`${fieldId}-capacity`}
            label="Capacity"
            hint={CAPACITY_HINT[enrolMode]}
          >
            <Input
              id={`${fieldId}-capacity`}
              type="number"
              min={1}
              max={MAX_OPEN_MODE_CAPACITY}
              inputMode="numeric"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              disabled={disabled}
              placeholder="e.g. 8"
            />
          </Field>
        </div>

        <SessionSlotField
          value={session}
          onChange={(next) => setSession({ ...session, ...next })}
          disabled={disabled}
        />

        <div className={styles.twoCol}>
          <Field id={`${fieldId}-location`} label="Location">
            <Input
              id={`${fieldId}-location`}
              value={session.location}
              onChange={(e) =>
                setSession({ ...session, location: e.target.value })
              }
              maxLength={GROUP_FIELD_LIMITS.location}
              disabled={disabled}
              placeholder="e.g. Portland A21"
            />
          </Field>
          <Field
            id={`${fieldId}-meeting`}
            label="Meeting link"
            hint="Members only see this via their own group card."
          >
            <Input
              id={`${fieldId}-meeting`}
              value={meetingUrlValue}
              onChange={(e) =>
                setSession({ ...session, meetingUrl: e.target.value })
              }
              maxLength={GROUP_FIELD_LIMITS.meetingUrl}
              disabled={disabled}
              placeholder="https://…"
            />
          </Field>
        </div>

        <Field
          id={`${fieldId}-notes`}
          label="Session notes"
          hint="Anything the group needs to know about how the session runs."
        >
          <CountedTextarea
            id={`${fieldId}-notes`}
            value={session.notes}
            max={GROUP_FIELD_LIMITS.notes}
            onChange={(e) => setSession({ ...session, notes: e.target.value })}
            disabled={disabled}
            rows={2}
          />
        </Field>

        <PersonSelector
          users={members}
          selected={facilitatorUids}
          onChange={setFacilitatorUids}
          label="Facilitators"
          role="facilitator"
          max={GROUP_FIELD_LIMITS.maxFacilitators}
        />

        <Switch
          checked={group.archived}
          onChange={toggleArchived}
          disabled={disabled}
          label="Archived"
          description="Archived groups stay on the run for the record but drop out of allocation."
        />
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button type="button" onClick={save} disabled={disabled}>
          Save group
        </Button>
      </div>
    </Card>
  );
}

/**
 * Inline "new group" form. Deliberately only asks for the three things a group
 * cannot exist without — everything else is edited on the card once it exists,
 * so creating six groups in a row stays fast.
 */
export function NewGroupForm({
  run,
  runAction,
  onCreated,
  onCancel,
  disabled,
}: {
  run: { id: string; courseId: string; label: string; enrolMode: CourseEnrolMode };
  runAction: ToastRun;
  onCreated: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  const fieldId = useId();
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [session, setSession] = useState<GroupSession>(DEFAULT_SESSION);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the group a name.");
      return;
    }
    // Same check as the card, for the same reason: an open-mode run's group
    // cannot be born uncapped, and the rules cannot say so in words.
    const nextCapacity = capacityFromInput(capacity);
    const capacityError = groupCapacityError(nextCapacity, run.enrolMode);
    if (capacityError) {
      setError(capacityError);
      return;
    }
    setError(null);
    let ok = false;
    await runAction(
      async () => {
        await createGroup(run, {
          name: trimmed,
          capacity: nextCapacity,
          session,
        });
        ok = true;
      },
      { savingMessage: "Creating group…", successMessage: "Group created" },
    );
    if (ok) {
      setName("");
      setCapacity("");
      setSession(DEFAULT_SESSION);
      onCreated();
    }
  }

  return (
    <Card padding="md">
      <h4 className={styles.groupName}>New group</h4>
      <div className={styles.fields}>
        <div className={styles.twoCol}>
          <Field id={`${fieldId}-new-name`} label="Group name">
            <Input
              id={`${fieldId}-new-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={GROUP_FIELD_LIMITS.name}
              disabled={disabled}
              placeholder="e.g. Tuesday evening"
              autoFocus
            />
          </Field>
          <Field
            id={`${fieldId}-new-capacity`}
            label="Capacity"
            hint={CAPACITY_HINT[run.enrolMode]}
          >
            <Input
              id={`${fieldId}-new-capacity`}
              type="number"
              min={1}
              max={MAX_OPEN_MODE_CAPACITY}
              inputMode="numeric"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              disabled={disabled}
              placeholder="e.g. 8"
            />
          </Field>
        </div>

        <SessionSlotField
          value={session}
          onChange={(next) => setSession({ ...session, ...next })}
          disabled={disabled}
        />
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <Button type="button" onClick={create} disabled={disabled}>
          Create group
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={disabled}
        >
          Cancel
        </Button>
      </div>
    </Card>
  );
}
