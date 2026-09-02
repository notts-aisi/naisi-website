import { NextResponse } from "next/server";
import { requireApplicant } from "@/lib/admissions/applicantSession";
import { loadStatusRows } from "@/lib/admissions/statusHubData";
import type { ApplicationStatusPayload } from "@/lib/admissions/statusTypes";

/**
 * `GET /api/admissions/applications/me` - every application the caller has,
 * joined to its round.
 *
 * The same rows `/applications` renders, from the same projection
 * (`buildStatusRow`), so the page and the API can never disagree about what an
 * applicant may see. The page does not fetch this route (it is a server
 * component reading the same loader directly); this exists for the client
 * surfaces that will want it, and as the thing the projection tests can point
 * at as "the wire".
 *
 * ## What is not on the wire
 *
 * Never the stored `email`, never `evidence` (a facilitator's private notes
 * about the applicant), never an unshared `outcome.reason`, never the
 * access-requirements answer. The reasons are written out once, in
 * `statusTypes.ts`, and enforced in one place, `buildStatusRow`.
 *
 * The session gate comes from `applicantSession.ts` rather than
 * `applyContext.ts` for the last of those: the apply context is the module
 * that can reach the access-requirements collection, and this route must be
 * provably unable to. The privacy scan in `tests/privacy-policy-v3.test.mjs`
 * reads the import list, which is the right thing for it to read.
 *
 * ## Not guarded against view-as, and that is the decision
 *
 * Every other applicant-lane route calls `assertNotImpersonating()`. Those all
 * WRITE, or (in `GET .../apply`) join the access-requirements answer, which is
 * health information the privacy notice promises is only read through a route
 * that logs it. This one does neither: it reads status, dates and the person's
 * own answers, which is exactly what "view as" exists to show an admin
 * debugging "my application has vanished". Adding the private join to this
 * route would make the guard necessary; do not add it.
 *
 * A `pending` account is a legitimate caller (`requireApplicant` admits it):
 * somebody who made an account at the fair and applied the same afternoon is
 * still pending on the Monday they come back to check.
 */
export async function GET() {
  const caller = await requireApplicant();
  if (caller instanceof NextResponse) return caller;
  const { user, db } = caller;

  try {
    const rows = await loadStatusRows(db, user.uid, new Date());
    return NextResponse.json({ rows } satisfies ApplicationStatusPayload);
  } catch (err) {
    console.error("[admissions status] read failed", user.uid, err);
    return NextResponse.json(
      { error: "Could not load your applications." },
      { status: 500 },
    );
  }
}
