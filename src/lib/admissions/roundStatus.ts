import {
  ADMISSION_ROUND_STATUSES,
  ADMISSION_ROUND_STATUS_LABEL,
  ADMISSION_ROUND_TRANSITIONS,
  type AdmissionRoundStatus,
} from "@/lib/firestore/admissionRounds";

/**
 * The round status MACHINE: what may follow what, and which moves have to be
 * confirmed before they happen.
 *
 * ## One table, and where it lives
 *
 * The transition map itself is `ADMISSION_ROUND_TRANSITIONS` in
 * `src/lib/firestore/admissionRounds.ts`, beside the union it is written in
 * terms of. This module is the only thing that INTERPRETS it: the status
 * route calls `planStatusChange` and so does the console's status control, so
 * a button that offers a move and a route that refuses it cannot drift apart.
 * There is deliberately no second copy of the arrows anywhere.
 *
 * That is safe ONLY because `admissionRounds` is `allow write: if false`, so
 * one Admin SDK route is the sole writer. The moment a client-direct write is
 * allowed onto the round document, this table has to be duplicated into
 * `firestore.rules` in the same change: `courseRuns` is the cautionary tale,
 * where a `canApproveCourse()` holder can walk a live run backwards to draft
 * because the server table has no counterpart in rules.
 *
 * ## Why a plan object rather than a boolean
 *
 * Two of the moves are not simply legal or illegal:
 *
 *  - `closed -> open` REOPENS a form people have already been told is shut.
 *    It is the extend-the-deadline path and it is legitimate, but it is not a
 *    move anybody should make by tapping a dropdown, so it carries
 *    `requiresConfirmation` and the route refuses it without an explicit
 *    `confirm: true`.
 *  - moving to the SAME status is not an error at all. A double-tapped button
 *    or a retried request must not 400, and must not write an audit line
 *    claiming something changed, so it comes back as `noop`.
 *
 * A boolean would have collapsed both of those into "allowed", and the
 * refusal copy would then have been written twice, once in the route and once
 * in the console.
 */

export type StatusTransitionCode = "unknown-status" | "terminal" | "illegal";

export type StatusTransitionPlan =
  | {
      ok: true;
      /** The requested status equals the current one: write nothing. */
      kind: "noop";
      requiresConfirmation: false;
    }
  | {
      ok: true;
      kind: "move";
      /** True for `closed -> open`: the route needs `confirm: true` in the body. */
      requiresConfirmation: boolean;
      /** The sentence the console types into its confirmation dialog. */
      confirmPrompt: string | null;
    }
  | {
      ok: false;
      code: StatusTransitionCode;
      /** Ready to hand back to an author as-is. */
      error: string;
    };

function isStatus(value: unknown): value is AdmissionRoundStatus {
  return (
    typeof value === "string"
    && ADMISSION_ROUND_STATUSES.includes(value as AdmissionRoundStatus)
  );
}

const REOPEN_PROMPT =
  "Reopening tells everyone who has been shown a closed form that it is "
  + "accepting applications again, and lets anyone who withdrew apply once "
  + "more. Only do this if you are genuinely extending the window.";

/**
 * Can this round move from `from` to `to`, and does the move need confirming?
 *
 * `from` is read off the stored document, so a round whose status field is
 * junk (hand-edited, or written before the union existed) is reported as an
 * unknown status rather than being quietly treated as a draft: a machine that
 * repairs its own input is a machine that can move a live round somewhere
 * nobody asked for.
 */
export function planStatusChange(from: unknown, to: unknown): StatusTransitionPlan {
  if (!isStatus(from)) {
    return {
      ok: false,
      code: "unknown-status",
      error:
        "This round's status is not one this site recognises, so it cannot be moved.",
    };
  }
  if (!isStatus(to)) {
    return {
      ok: false,
      code: "unknown-status",
      error: "That is not a status a round can be in.",
    };
  }

  if (from === to) return { ok: true, kind: "noop", requiresConfirmation: false };

  const allowed = ADMISSION_ROUND_TRANSITIONS[from];
  if (allowed.length === 0) {
    return {
      ok: false,
      code: "terminal",
      error: `A ${ADMISSION_ROUND_STATUS_LABEL[from].toLowerCase()} round is finished and cannot be moved again.`,
    };
  }
  if (!allowed.includes(to)) {
    const names = allowed
      .map((s) => ADMISSION_ROUND_STATUS_LABEL[s].toLowerCase())
      .join(" or ");
    return {
      ok: false,
      code: "illegal",
      error: `A round that is ${ADMISSION_ROUND_STATUS_LABEL[from].toLowerCase()} can only move to ${names}.`,
    };
  }

  const reopening = from === "closed" && to === "open";
  return {
    ok: true,
    kind: "move",
    requiresConfirmation: reopening,
    confirmPrompt: reopening ? REOPEN_PROMPT : null,
  };
}

/** The moves the console offers from here, in table order. */
export function nextStatuses(from: AdmissionRoundStatus): AdmissionRoundStatus[] {
  return ADMISSION_ROUND_TRANSITIONS[from] ?? [];
}
