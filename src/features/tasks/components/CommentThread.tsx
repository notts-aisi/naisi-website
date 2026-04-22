"use client";

import type { TaskDoc } from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import { useCommentsAndActivity } from "../hooks/useCommentsAndActivity";
import ActivityFeed from "./ActivityFeed";
import CommentComposer from "./CommentComposer";

/**
 * Wires the live comments + activity feed into the ActivityFeed renderer and
 * the CommentComposer. The composer needs the activity stream to decide
 * whether a send-for-review is already pending (button disables while a
 * review is in flight).
 */

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
  const { feed, activity, loading } = useCommentsAndActivity(task.id);

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
        <CommentComposer mode="create" task={task} users={users} activity={activity} />
      )}
    </div>
  );
}
