import type { AdmissionRoundDoc } from "@/lib/firestore/admissionRounds";

/**
 * The appointment round's small pure rules, on their own so BOTH SIDES of the
 * client boundary can hold them.
 *
 * `appointmentDecideBlock` is asked by three surfaces: the decide route (which
 * answers 409 with the sentence), the queue page (which shows it and hides the
 * buttons), and the round editor, which is a client component. It used to live
 * in `appointmentQueue.ts`, and reaching it from the editor pulled that whole
 * projection into the browser graph, and behind it `statusHub.ts`,
 * `applyRoutes.ts` and `roundRoutes.ts`, the last two of which open with
 * `import "server-only"`. The production build refuses that; `tsc` does not
 * see it at all.
 *
 * So the rule lives here, importing nothing but a type, and
 * `appointmentQueue.ts` re-exports it so no server call site changed.
 * `tests/client-server-boundary.test.mjs` walks the real import graph and
 * fails on any client component that reaches a server-only module again.
 */

/**
 * Why this round cannot be decided right now, or null when it can.
 *
 * One sentence, shared by the route (which answers 409 with it) and by the
 * page (which shows it and hides the buttons), so the queue never offers a
 * press the route will refuse. The three states, and why each is a refusal:
 *
 *  - **archived**: tidied away. Deciding on it would move counters on a round
 *    nobody is looking at any more.
 *  - **draft**: never opened, so nobody could have applied. Anything sitting
 *    on it is test data or a leftover, and appointing somebody from it mails
 *    them about a round that does not exist yet.
 *  - **cancelled**: the round stopped asking. It has already told its
 *    applicants nothing more is happening, and an appointment email arriving
 *    afterwards contradicts that in the recipient's inbox.
 *
 * The same three the stage-release route refuses on, said the same way.
 */
export function appointmentDecideBlock(
  round: Pick<AdmissionRoundDoc, "status" | "archived">,
): string | null {
  if (round.archived) {
    return "This round is archived. Bring it back out of the archive before deciding anything on it.";
  }
  if (round.status === "draft") {
    return "This round is not open yet, so nobody has applied to it. Open the round first.";
  }
  if (round.status === "cancelled") {
    return "This round is cancelled, so it is not appointing anybody. Nothing here can be decided.";
  }
  return null;
}
