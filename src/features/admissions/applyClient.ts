"use client";

import type {
  ApplicantApplication,
  ApplicantRound,
  ApplicantStage,
  ApplyContextPayload,
} from "@/lib/admissions/applyTypes";
import type { ApplicationProgrammePreference } from "@/lib/firestore/admissionApplications";
import type { AvailabilityMask } from "@/lib/admissions/availability";
import type { RsvpAnswer } from "@/lib/firestore/events";

/**
 * The apply flow's ONE door to the admissions API.
 *
 * `admissionApplications` and the round's `stages` subcollection are both
 * `allow read, write: if false`, so unlike most surfaces here there is no
 * client-direct Firestore read to fall back on: every fetch and every write is
 * a route call, and this module is where they live.
 *
 * Every helper throws an `ApplyApiError` carrying the SERVER's sentence, plus
 * the `questionId` and `stageId` the server named. The routes answer with copy
 * an applicant can act on ("Why this course? is required."), and re-writing it
 * in the browser would mean two sets of words for one refusal, drifting apart
 * on the first change to either.
 */

export type { ApplicantApplication, ApplicantRound, ApplicantStage, ApplyContextPayload };

export class ApplyApiError extends Error {
  status: number;
  /** The question the message belongs against, when the server named one. */
  questionId?: string;
  /** The stage that question is on, so the flow can open the right one. */
  stageId?: string;
  /** Present on a 409 from POST: the row that already exists. */
  application?: ApplicantApplication | null;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = "ApplyApiError";
    this.status = status;
    if (typeof body.questionId === "string") this.questionId = body.questionId;
    if (typeof body.stageId === "string") this.stageId = body.stageId;
    if (body.application !== undefined) {
      this.application = body.application as ApplicantApplication | null;
    }
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an empty body, or a proxy error page */
  }
  if (!res.ok) {
    const message =
      typeof body.error === "string" && body.error
        ? body.error
        : `That did not go through (${res.status}).`;
    throw new ApplyApiError(message, res.status, body);
  }
  return body as T;
}

function base(roundId: string): string {
  return `/api/admissions/rounds/${encodeURIComponent(roundId)}`;
}

/** The round, its stages (questions only where released) and the caller's row. */
export function fetchApplyContext(roundId: string): Promise<ApplyContextPayload> {
  return call<ApplyContextPayload>(`${base(roundId)}/apply`);
}

/** The stages alone. Used to pick up a stage that has released since load. */
export function fetchStages(
  roundId: string,
): Promise<{ round: ApplicantRound; stages: ApplicantStage[] }> {
  return call(`${base(roundId)}/stages`);
}

export type StartResult = {
  ok: true;
  created: boolean;
  application: ApplicantApplication | null;
};

/**
 * Start a draft, or re-open a withdrawn one.
 *
 * A 409 means a row already exists, and the error carries it, so the caller
 * opens the draft rather than showing a failure about a form the applicant can
 * see. That is the double-tap case and the second-tab case at once.
 */
export function startApplication(
  roundId: string,
  recaptchaToken: string | null,
): Promise<StartResult> {
  return call<StartResult>(`${base(roundId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ recaptchaToken }),
  });
}

export type DraftPatch = {
  stageAnswers?: Record<string, Record<string, RsvpAnswer>>;
  availability?: AvailabilityMask;
  programmePreference?: ApplicationProgrammePreference;
  accessRequirements?: string;
};

export function saveDraft(
  roundId: string,
  patch: DraftPatch,
): Promise<{ ok: true; savedAt: string; application: ApplicantApplication | null }> {
  return call(`${base(roundId)}/apply`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function submitApplication(
  roundId: string,
  recaptchaToken: string | null,
): Promise<{ ok: true; application: ApplicantApplication | null }> {
  return call(`${base(roundId)}/apply/submit`, {
    method: "POST",
    body: JSON.stringify({ recaptchaToken }),
  });
}

/** Submit one later-released stage, after the first submission has gone in. */
export function submitStage(
  roundId: string,
  stageId: string,
  answers: Record<string, RsvpAnswer>,
  recaptchaToken: string | null,
): Promise<{ ok: true; application: ApplicantApplication | null }> {
  return call(`${base(roundId)}/apply/stage/${encodeURIComponent(stageId)}`, {
    method: "POST",
    body: JSON.stringify({ answers, recaptchaToken }),
  });
}

/** The word the confirmation box asks for. Compared case-insensitively. */
export const WITHDRAW_WORD = "WITHDRAW";

export function withdrawApplication(
  roundId: string,
  confirm: string,
): Promise<{ ok: true; application: ApplicantApplication | null }> {
  return call(`${base(roundId)}/apply`, {
    method: "DELETE",
    body: JSON.stringify({ confirm }),
  });
}
