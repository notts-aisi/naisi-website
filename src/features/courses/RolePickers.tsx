"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import PersonSelector from "@/components/ui/PersonSelector";
import { COURSE_FIELD_LIMITS } from "@/lib/firestore/courses";
import type { UserDoc } from "@/lib/firestore/users";
import { assignRunRoles } from "./courseMutations";
import styles from "./RolePickers.module.css";

/**
 * Per-run role assignment: admissions reviewers, track leads, run
 * facilitators.
 *
 * These three arrays are server-owned — pinned in the `courseRuns` rules and
 * mutated only by the roles route — so the picker collects intent and
 * `assignRunRoles` (a fetch-backed helper) does the write. Nothing here is a
 * client-direct update.
 *
 * Admissions is a DIFFERENT array from facilitation on purpose: reviewing
 * applicants grants no access to the cohort, and facilitating a group grants
 * no sight of anyone's application. Keeping the two pickers visibly separate
 * is part of that boundary, not a layout accident.
 *
 * Current values come from the run doc (which is what the roles route writes),
 * so the section reseeds from the same one-shot read the rest of the editor
 * uses — no second round trip that could disagree with what is on screen.
 */

type ToastRun = (
  action: () => Promise<void>,
  opts?: { savingMessage?: string; successMessage?: string },
) => Promise<void>;

type Props = {
  runId: string;
  admissionsReviewerUids: string[];
  trackLeadUids: string[];
  runFacilitatorUids: string[];
  members: UserDoc[];
  membersLoading?: boolean;
  runAction: ToastRun;
  onSaved: () => void;
  disabled?: boolean;
};

function sameUids(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((uid, i) => uid === b[i]);
}

export default function RolePickers({
  runId,
  admissionsReviewerUids,
  trackLeadUids,
  runFacilitatorUids,
  members,
  membersLoading,
  runAction,
  onSaved,
  disabled,
}: Props) {
  const [reviewers, setReviewers] = useState(admissionsReviewerUids);
  const [leads, setLeads] = useState(trackLeadUids);
  const [facilitators, setFacilitators] = useState(runFacilitatorUids);

  // Reseed on every reload of the run doc. The three arrays come from one
  // normalised read, so one synced tuple tracks all of them. Adjusted during
  // render rather than in an effect, per the React docs and TimeField's
  // precedent.
  const [synced, setSynced] = useState({
    reviewers: admissionsReviewerUids,
    leads: trackLeadUids,
    facilitators: runFacilitatorUids,
  });
  if (
    synced.reviewers !== admissionsReviewerUids ||
    synced.leads !== trackLeadUids ||
    synced.facilitators !== runFacilitatorUids
  ) {
    setSynced({
      reviewers: admissionsReviewerUids,
      leads: trackLeadUids,
      facilitators: runFacilitatorUids,
    });
    setReviewers(admissionsReviewerUids);
    setLeads(trackLeadUids);
    setFacilitators(runFacilitatorUids);
  }

  const dirty =
    !sameUids(reviewers, admissionsReviewerUids) ||
    !sameUids(leads, trackLeadUids) ||
    !sameUids(facilitators, runFacilitatorUids);

  async function save() {
    let ok = false;
    await runAction(
      async () => {
        await assignRunRoles(runId, {
          admissionsReviewerUids: reviewers,
          trackLeadUids: leads,
          runFacilitatorUids: facilitators,
        });
        ok = true;
      },
      { savingMessage: "Saving roles…", successMessage: "Roles saved" },
    );
    if (ok) onSaved();
  }

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        Reviewing applications and facilitating a group are separate jobs —
        someone on the admissions list sees applicants but not the cohort, and a
        facilitator sees their group but not anyone&apos;s application.
      </p>

      {membersLoading && <p className={styles.hint}>Loading people…</p>}

      <div className={styles.pickers}>
        <PersonSelector
          users={members}
          selected={reviewers}
          onChange={setReviewers}
          label="Admissions reviewers"
          role="reviewer"
          max={COURSE_FIELD_LIMITS.maxAdmissionsReviewers}
        />
        <PersonSelector
          users={members}
          selected={leads}
          onChange={setLeads}
          label="Track leads"
          role="reviewer"
          tone="neutral"
          max={COURSE_FIELD_LIMITS.maxTrackLeads}
        />
        <PersonSelector
          users={members}
          selected={facilitators}
          onChange={setFacilitators}
          label="Run facilitators"
          role="facilitator"
          max={COURSE_FIELD_LIMITS.maxRunFacilitators}
        />
      </div>

      <div className={styles.actions}>
        <Button type="button" onClick={save} disabled={disabled || !dirty}>
          Save roles
        </Button>
      </div>
    </div>
  );
}
