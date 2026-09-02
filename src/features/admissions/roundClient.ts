"use client";

import type { FormQuestion } from "@/lib/firestore/events";
import type {
  AdmissionCriterion,
  AdmissionRoundDoc,
  AdmissionRoundStatus,
  AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";

/**
 * The console's ONE door to the rounds API.
 *
 * `admissionRounds` and its `stages` subcollection are `allow read, write: if
 * false`, so unlike every other admin surface in this app there is no
 * client-direct Firestore read to fall back on: everything here is a route
 * call. That is the point rather than a limitation, and it is why the parsing
 * lives in one module. Dates cross the wire as ISO strings; they are turned
 * back into `Date` objects exactly once, here, so no component ever holds a
 * date that is secretly a string.
 *
 * Every helper throws an `Error` carrying the SERVER's sentence. The routes
 * answer with copy an author can act on ("that stage name is 12 characters too
 * long"), and re-writing it in the browser would mean two sets of words for
 * one refusal.
 */

/** A round as the routes send it: `AdmissionRoundDoc` with ISO date strings. */
export type RoundPayload = Omit<
  AdmissionRoundDoc,
  "opensAt" | "closesAt" | "createdAt" | "updatedAt"
> & {
  opensAt: string | null;
  closesAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type StagePayload = Omit<
  AdmissionStageDoc,
  "questions" | "manualReleasedAt" | "closesAt" | "createdAt" | "updatedAt"
> & {
  questions?: FormQuestion[];
  questionCount: number;
  manualReleasedAt: string | null;
  closesAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** The same round with real `Date`s. What the components hold. */
export type Round = AdmissionRoundDoc;
export type Stage = AdmissionStageDoc & { questionCount: number };

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function hydrateRound(payload: RoundPayload): Round {
  return {
    ...payload,
    opensAt: toDate(payload.opensAt),
    closesAt: toDate(payload.closesAt),
    createdAt: toDate(payload.createdAt),
    updatedAt: toDate(payload.updatedAt),
  };
}

export function hydrateStage(payload: StagePayload): Stage {
  return {
    ...payload,
    questions: payload.questions ?? [],
    questionCount: payload.questionCount,
    manualReleasedAt: toDate(payload.manualReleasedAt),
    closesAt: toDate(payload.closesAt),
    createdAt: toDate(payload.createdAt),
    updatedAt: toDate(payload.updatedAt),
  };
}

/** A refusal that carries the extra fields a caller may want to act on. */
export class RoundApiError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = "RoundApiError";
    this.status = status;
    this.body = body;
  }

  /** True when the server is asking for `force: true` or `confirm: true`. */
  get needsConfirmation(): boolean {
    return this.body.needsForce === true || this.body.needsConfirmation === true;
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
    /* an empty body on a 204 or a proxy error page */
  }
  if (!res.ok) {
    const message =
      typeof body.error === "string" && body.error
        ? body.error
        : `That did not save (${res.status}).`;
    throw new RoundApiError(message, res.status, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------

export async function fetchRounds(): Promise<{ rounds: Round[]; canAuthor: boolean }> {
  const body = await call<{ rounds: RoundPayload[]; canAuthor: boolean }>(
    "/api/admissions/rounds",
  );
  return { rounds: body.rounds.map(hydrateRound), canAuthor: body.canAuthor };
}

export async function createRound(input: {
  label: string;
  kind: AdmissionRoundDoc["kind"];
  academicYear: string;
}): Promise<{ id: string }> {
  return call<{ id: string }>("/api/admissions/rounds", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchRound(roundId: string): Promise<{
  round: Round;
  stages: Stage[];
  canAuthor: boolean;
}> {
  const body = await call<{
    round: RoundPayload;
    stages: StagePayload[];
    canAuthor: boolean;
  }>(`/api/admissions/rounds/${encodeURIComponent(roundId)}`);
  return {
    round: hydrateRound(body.round),
    stages: body.stages.map(hydrateStage),
    canAuthor: body.canAuthor,
  };
}

/**
 * Save one SECTION of the round. Partial by design: the console saves the
 * section you edited, so the submitted-applications freeze only ever fires on
 * a section you actually touched.
 */
export async function patchRound(
  roundId: string,
  patch: Record<string, unknown>,
): Promise<Round> {
  const body = await call<{ round: RoundPayload }>(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return hydrateRound(body.round);
}

export async function setRoundStatus(
  roundId: string,
  status: AdmissionRoundStatus,
  confirm = false,
): Promise<AdmissionRoundStatus> {
  const body = await call<{ status: AdmissionRoundStatus }>(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}/status`,
    { method: "POST", body: JSON.stringify({ status, confirm }) },
  );
  return body.status;
}

export async function setRoundRoles(
  roundId: string,
  roles: { reviewerUids: string[]; finalDeciderUid: string | null },
): Promise<Round> {
  const body = await call<{ round: RoundPayload }>(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}/roles`,
    { method: "PUT", body: JSON.stringify(roles) },
  );
  return hydrateRound(body.round);
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export async function saveStage(
  roundId: string,
  stageId: string,
  stage: {
    label: string;
    intro: string;
    questions: FormQuestion[];
    releaseAt: string | null;
    releaseTimeLocal: string;
    closesAt: string | null;
    locksOnSubmit: boolean;
  },
): Promise<Stage> {
  const body = await call<{ stage: StagePayload }>(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}/stages/${encodeURIComponent(stageId)}`,
    { method: "PUT", body: JSON.stringify(stage) },
  );
  return hydrateStage(body.stage);
}

export async function deleteStage(roundId: string, stageId: string): Promise<void> {
  await call(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}/stages/${encodeURIComponent(stageId)}`,
    { method: "DELETE" },
  );
}

export async function releaseStage(roundId: string, stageId: string): Promise<Stage> {
  const body = await call<{ stage: StagePayload }>(
    `/api/admissions/rounds/${encodeURIComponent(roundId)}/stages/${encodeURIComponent(stageId)}/release`,
    { method: "POST" },
  );
  return hydrateStage(body.stage);
}

// ---------------------------------------------------------------------------
// Small shared formatters
// ---------------------------------------------------------------------------

export type { AdmissionCriterion };
