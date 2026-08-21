import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import StaffEmailComposer from "@/features/courses/StaffEmailComposer";
import { getRunAccess, getSessionUser } from "@/features/courses/runAccess";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";

/**
 * Server shell for the group lane of the staff email composer — the
 * OPERATIONAL one. Its twin is `/learn/[runId]/email`, the cohort
 * announcement lane, which the same component serves with a different
 * audience and a stricter gate.
 *
 * THE SAME GATE AS THE GROUP PAGE, spelled out again rather than shared: a
 * facilitator of THIS group while it is live, or an admin. Being on the run,
 * reviewing its applications, or facilitating a different group are all
 * insufficient — mailing a group is the single loudest thing this feature can
 * do, and the archived-group rule ("archiving a group unstaffs it") holds here
 * exactly as it does everywhere else.
 *
 * Redirects, never 403s: someone guessing group ids learns nothing about which
 * ones exist. The SEND ROUTE re-derives the same access from the same
 * documents and is the real boundary — this gate only decides who is shown a
 * door.
 */

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

/** Inline, like the review page beside it — see the group page's note. */
const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-6)",
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--color-text-muted)",
};

const subStyle: CSSProperties = {
  margin: "var(--space-2) 0 0",
  maxWidth: "62ch",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
  color: "var(--color-text-muted)",
};

const linkStyle: CSSProperties = { color: "var(--color-accent)" };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function GroupEmailPage({
  params,
}: {
  params: Promise<{ runId: string; groupId: string }>;
}) {
  const { runId, groupId } = await params;

  const access = await getRunAccess(runId);
  if (!access) {
    // Null is "no session" OR "no such run" — deliberately fused in
    // `getRunAccess`. `getSessionUser` is memoised by now, so telling the two
    // apart costs nothing and leaks nothing.
    const user = await getSessionUser();
    redirect(user ? "/learn" : "/login");
  }

  const runHome = `/learn/${encodeURIComponent(runId)}`;

  // Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
  // separator and `doc()` would throw — a 500 out of a gate whose whole job is
  // to redirect.
  if (!groupId || groupId.includes("/") || groupId === "." || groupId === "..") {
    redirect(runHome);
  }

  const db = getAdminDb();
  if (!db) redirect(runHome);

  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  if (!groupSnap.exists) redirect(runHome);
  const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});

  const facilitatesThisGroup =
    !group.archived && group.facilitatorUids.includes(access.user.uid);
  if (group.runId !== runId || !(access.isAdmin || facilitatesThisGroup)) {
    redirect(runHome);
  }

  const eyebrow = [access.run.courseTitle, access.run.label].filter(Boolean).join(" · ");
  const groupPath = `${runHome}/group/${encodeURIComponent(groupId)}`;
  const groupLabel = group.name || "your group";

  return (
    <div style={pageStyle}>
      <div>
        {eyebrow && <p style={eyebrowStyle}>{eyebrow}</p>}
        <h1 style={{ margin: "var(--space-2) 0 0" }}>Email {groupLabel}</h1>
        <p style={subStyle}>
          For things the group needs to know: a moved room, a cancelled session, a
          reminder before Tuesday. It reaches the people placed in {groupLabel} and
          nobody else, and you never see their addresses.{" "}
          <Link href={groupPath} style={linkStyle}>
            Back to the group
          </Link>
        </p>
      </div>

      <StaffEmailComposer
        runId={runId}
        audience={{ kind: "group", groupId, groupName: group.name }}
      />
    </div>
  );
}
