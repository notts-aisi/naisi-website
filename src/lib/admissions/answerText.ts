import type { RsvpAnswer } from "@/lib/firestore/events";

/**
 * One stored answer, as a sentence.
 *
 * ## Why this is its own module
 *
 * It is read on both sides of the client boundary: the applicant's own
 * read-back (`statusHub.ts`, and the server-rendered hub pages behind it) and
 * the appointment queue's projection, which a client component reaches through
 * `appointmentQueue.ts`. It lived in `statusHub.ts`, whose import of the apply
 * tree's serialisers pulls `applyRoutes.ts` and `roundRoutes.ts` in behind it,
 * and both of those open with `import "server-only"`. So importing one small
 * pure helper dragged two server modules into the browser graph, which
 * `tsc` cannot see and only a production build reports.
 *
 * The rule this module exists to hold: a helper both halves need is a LEAF
 * that imports nothing server-only, and the server modules re-export it. See
 * `tests/client-server-boundary.test.mjs`, which walks the real graph.
 *
 * `statusHub.ts` re-exports it, so every existing call site is unchanged.
 */
export function answerText(value: RsvpAnswer | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  const other = value.other?.trim();
  return [...value.checked, other ? `Other: ${other}` : ""].filter(Boolean).join(", ");
}
