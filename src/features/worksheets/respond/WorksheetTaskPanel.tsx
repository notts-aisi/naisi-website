"use client";

import Link from "next/link";
import Chip, { type ChipTone } from "@/components/ui/Chip";
import ProgressBar from "@/components/ui/ProgressBar";
import Skeleton from "@/components/ui/Skeleton";
import { useCirculation } from "@/features/worksheets/hooks/useCirculation";
import { useResponse } from "@/features/worksheets/hooks/useResponse";
import {
  RESPONSE_STATE_LABELS,
  type ResponseState,
} from "@/lib/firestore/circulations";
import type { TaskDoc } from "@/lib/firestore/tasks";
import { formatActiveTime } from "./respondHelpers";
import styles from "./WorksheetTaskPanel.module.css";

/**
 * What a worksheet task shows in place of its subtasks.
 *
 * A worksheet task carries no subtasks and no blocks: its Done is decided by
 * the worksheet's own lifecycle (the submit, return and unfreeze routes all
 * move the task from the response), so the lock-in ritual and the review
 * matrix would be ceremony with no participants. This panel is what the
 * section is for instead: state, progress, and the way through.
 *
 * ── TWO AUDIENCES, ONE DOCUMENT ─────────────────────────────────────────────
 * The recipient sees their own progress and a link to answer. Staff see the
 * same numbers about that one person and a link to the circulation, where the
 * whole roster and the review tools live. Nothing here lists anybody else: a
 * task is about one recipient, and the panel keeps to that.
 *
 * ── WHY IT READS THE RESPONSE RATHER THAN TRUSTING THE TASK ─────────────────
 * The task's status is a mirror. The response is the thing being mirrored, and
 * it carries the progress numbers and the activity the task has nowhere to
 * put. Reading it also means the panel is only ever populated for somebody the
 * rules let read it: a forged `artefact` pointer on a hand-made task renders a
 * panel that opens nothing, which is exactly what the pointer's own module
 * comment promises.
 */

const STATE_TONE: Record<ResponseState, ChipTone> = {
  "not-opened": "neutral",
  started: "accent",
  submitted: "success",
  reviewed: "success",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function WorksheetTaskPanel({
  task,
  viewerUid,
  viewerIsStaff,
}: {
  task: TaskDoc;
  viewerUid: string;
  viewerIsStaff: boolean;
}) {
  const circulationId =
    task.artefact?.kind === "worksheet-response" ? task.artefact.circulationId : null;
  /** One completer per worksheet task, and they are the recipient. */
  const recipientUid = task.completerUids[0] ?? null;

  const { circulation, loading: circulationLoading } = useCirculation(circulationId);
  const { response, loading: responseLoading } = useResponse(circulationId, recipientUid);

  if (!circulationId) return null;

  if (circulationLoading || responseLoading) {
    return (
      <div className={styles.root}>
        <Skeleton height="1rem" lines={3} ariaLabel="Loading this worksheet…" />
      </div>
    );
  }

  // The viewer's own response beats their staff role: somebody reviewing a
  // circulation they were also sent should still be pointed at their own
  // answers from their own task.
  const isRecipient = viewerUid === recipientUid;
  const state: ResponseState = response?.state ?? "not-opened";
  const progress = response?.progress ?? { answered: 0, total: 0 };
  const activity = response?.activity ?? null;

  return (
    <div className={styles.root}>
      <div className={styles.headRow}>
        <Chip tone={STATE_TONE[state]} size="sm">
          {RESPONSE_STATE_LABELS[state]}
        </Chip>
        {circulation?.dueDate && (
          <Chip tone="neutral" size="sm">
            Due {formatDate(circulation.dueDate)}
          </Chip>
        )}
      </div>

      {circulation?.title && <p className={styles.name}>{circulation.title}</p>}

      {progress.total > 0 && (
        <ProgressBar
          value={progress.answered}
          max={progress.total}
          showLabel
          ariaLabel="Questions answered"
        />
      )}

      {isRecipient ? (
        <p className={styles.meta}>
          {activity?.firstOpenedAt
            ? `You first opened this on ${formatDate(activity.firstOpenedAt)}.`
            : "You have not opened this yet."}
        </p>
      ) : (
        <p className={styles.meta}>
          {activity?.firstOpenedAt
            ? `First opened ${formatDate(activity.firstOpenedAt)} · ${activity.pageOpens} page ${
                activity.pageOpens === 1 ? "open" : "opens"
              } · ${formatActiveTime(activity.activeMs)} spent.`
            : "Not opened yet."}
        </p>
      )}

      {!response && (
        <p className={styles.meta}>
          This response is not readable from here. Open the circulation for the full
          picture.
        </p>
      )}

      {isRecipient ? (
        <Link className={styles.action} href={`/worksheets/respond/${circulationId}`}>
          Open worksheet
        </Link>
      ) : (
        viewerIsStaff &&
        circulation && (
          <Link
            className={styles.action}
            href={`/worksheets/${circulation.worksheetId}/circulations/${circulationId}`}
          >
            Open circulation
          </Link>
        )
      )}
    </div>
  );
}
