import "server-only";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";

/**
 * The applicant's session gate, and the Admin SDK handle that comes with it.
 *
 * ## Why this is its own module and not part of `applyContext.ts`
 *
 * `applyContext.ts` is where the apply tree's document helpers live, and two of
 * them (`privateRef`, `loadOwnApplication`) reach
 * `admissionApplicationPrivate`, the collection holding the
 * access-requirements answer. The privacy policy promises that every read of
 * that answer is recorded, and `tests/privacy-policy-v3.test.mjs` enforces the
 * promise by scanning route sources: a route that can reach that collection,
 * including by importing the module that can, has to either log the read or be
 * listed in the owner lane with a reason.
 *
 * That is the right scan. It also means the session gate cannot live in the
 * same module as the private join, or every route that merely needs to know
 * who is calling drags the private collection into its import graph and has to
 * be argued about. So the gate lives here, this module reaches nothing but the
 * session and the SDK handle, and `applyContext.ts` re-exports it so the
 * existing apply routes are untouched.
 */

export type Db = NonNullable<ReturnType<typeof getAdminDb>>;

export type Caller = { user: SessionUser; db: Db };

/**
 * Session plus the Admin SDK, or the response to return instead.
 *
 * `pending` accounts are ALLOWED, deliberately and load-bearingly: the whole
 * funnel is "register, then apply", and the account made at the fair on Monday
 * is still pending on Sunday when applications close. A `rejected` account is
 * the only signed-in caller turned away.
 */
export async function requireApplicant(): Promise<Caller | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (user.role === "rejected") {
    return NextResponse.json(
      { error: "This account cannot apply." },
      { status: 403 },
    );
  }
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured." }, { status: 500 });
  }
  return { user, db };
}
