"use client";

import type { TaskDoc } from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import { useCommentsAndActivity } from "../hooks/useCommentsAndActivity";
import ActivityFeed from "./ActivityFeed";
import CommentComposer from "./CommentComposer";

type Props = {
  task: TaskDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  /** True when viewer can participate (completer, reviewer, admin, or
   *  committee-on-committee-task). False → read-only. */
  canParticipate: boolean;
};

export default function CommentThread({
  task,
  users,
  viewerUid,
  viewerIsAdmin,
  canParticipate,
}: Props) {
  const { feed, loading } = useCommentsAndActivity(task.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <ActivityFeed
        task={task}
        users={users}
        viewerUid={viewerUid}
        viewerIsAdmin={viewerIsAdmin}
        feed={feed}
        loading={loading}
      />
      {canParticipate && (
        <CommentComposer mode="create" task={task} users={users} />
      )}
    </div>
  );
}
