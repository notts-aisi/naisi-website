import { redirect } from "next/navigation";
import AdmissionsQueue from "@/features/courses/AdmissionsQueue";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * A reviewer's whole course surface: the admissions queue for one run, and
 * nothing else.
 *
 * Admissions is a SEPARATE ROLE from facilitation (locked decision). Being on
 * a run's `admissionsReviewerUids` grants sight of its applications and no
 * sight of its cohort — there is deliberately no link from here into the
 * learning space, and no other `/learn/[runId]/*` route accepts a reviewer.
 *
 * The gate below is intentionally SELF-CONTAINED rather than inherited: there
 * is no `/learn/[runId]/layout.tsx` yet. P7 adds one (it computes the full
 * `RunAccess` for enrolled members, facilitators, reviewers, track leads and
 * admins) and this page is meant to fold into it then — at which point this
 * block becomes a narrowing check against the layout's access object rather
 * than a fresh read. Until that lands, deleting anything here removes the only
 * thing standing between a signed-in member and a pile of applications.
 *
 * Track leads may READ this queue but may not decide; that split lives in the
 * routes (the decide/notes handlers re-check), which is where it belongs —
 * a page gate that let the wrong person in would otherwise be the only
 * boundary.
 */

export const dynamic = "force-dynamic";

export default async function RunAdmissionsPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  // `(app)/layout.tsx` has already established a signed-in, non-pending user;
  // this re-reads it because the decision below needs the uid and the role.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const db = getAdminDb();
  if (!db) redirect("/learn");

  const snap = await db.collection("courseRuns").doc(runId).get();
  if (!snap.exists) redirect("/learn");
  const run = normalizeCourseRun(snap.id, snap.data() ?? {});

  const allowed =
    user.role === "admin" ||
    run.admissionsReviewerUids.includes(user.uid) ||
    run.trackLeadUids.includes(user.uid);
  // A plain redirect, not a 403: a member who lands here by guessing a run id
  // learns nothing about whether that run exists.
  if (!allowed) redirect("/learn");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-sm)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--color-text-muted)",
          }}
        >
          {run.courseTitle || "Course"} — {run.label || "Untitled run"}
        </p>
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Admissions</h1>
      </div>

      {/* `isAdmin` controls exactly one thing: whether applicant email
          addresses render. The route decides whether any were sent. */}
      <AdmissionsQueue runId={runId} isAdmin={user.role === "admin"} />
    </div>
  );
}
