import Link from "next/link";
import AllocationBoard from "@/features/courses/AllocationBoard";

/**
 * The admin mount of the group-allocation board.
 *
 * Thin on purpose: `(app)/admin/layout.tsx` already gates on `role === "admin"`
 * server-side, so this page owes nothing but the breadcrumb and the board.
 *
 * TRACK LEADS: the allocation ROUTES are gated to `admin ∪ run.trackLeadUids`,
 * which is wider than this page. That is not an oversight — a non-admin track
 * lead cannot reach `/admin/**` at all, and giving them a second admin-shaped
 * URL would mean two places where the gate has to be got right. Their mount is
 * the learn-side one in P7 (`/learn/[runId]/allocation`), rendering this same
 * component against the same routes; the route gate is the boundary either way,
 * and this page is only the admin's door to it.
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
