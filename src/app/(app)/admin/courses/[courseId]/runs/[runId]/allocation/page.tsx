import Link from "next/link";
import AllocationBoard from "@/features/courses/AllocationBoard";

/**
 * The admin mount of the group-allocation board.
 *
 * Thin on purpose: `courses/layout.tsx` gates the tree server-side with
 * `requireCourseAuthorPage()` (admin, `draftCourse` or `approveCourse`), so
 * this page owes nothing but the breadcrumb and the board.
 *
 * TRACK LEADS: the allocation ROUTES are gated to `admin ∪ run.trackLeadUids`,
 * which OVERLAPS this page's gate rather than nesting inside it. A track lead
 * who holds neither course permission cannot open this URL, and a drafter who
 * is not a track lead opens it and gets 403s from the board's own calls. That
 * is deliberate: the ROUTE is the boundary, this page is only one door to it,
 * and the track lead's door is the learn-side mount in P7
 * (`/learn/[runId]/allocation`), which renders this same component against
 * these same routes. RunEditor hides the link for a caller the routes will
 * refuse, so the dead end is not offered in the first place.
 */

export default async function AdminRunAllocationPage({
  params,
}: {
  params: Promise<{ courseId: string; runId: string }>;
}) {
  const { courseId, runId } = await params;
  const runHref = `/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-5)",
        // The board scrolls its columns inside its own bounds; this wrapper is
        // a flex item in AppShell's `<main>`, so it needs the min-width: 0 link
        // in that chain too (CLAUDE.md §Main-area width).
        minWidth: 0,
      }}
    >
      <Link
        href={runHref}
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted)",
          textDecoration: "none",
        }}
      >
        ← Back to the run editor
      </Link>

      <AllocationBoard courseId={courseId} runId={runId} />
    </div>
  );
}
