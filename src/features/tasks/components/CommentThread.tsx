"use client";

import type { TaskDoc } from "@/lib/firestore/tasks";
import type { UserDoc } from "@/lib/firestore/users";
import type { ActivityDoc } from "@/lib/firestore/taskActivity";
import type { FeedEntry } from "../hooks/useCommentsAndActivity";
import ActivityFeed from "./ActivityFeed";
import CommentComposer from "./CommentComposer";

/**
 * Thread wrapper — renders the live feed + composer. Accepts feed/activity
 * as props (rather than fetching them here) so the parent can share the
 * single useCommentsAndActivity subscription between the discussion view
 * and the subtask pending-review derivation.
 */
type Props = {
  task: TaskDoc;
  users: UserDoc[];
  viewerUid: string;
  viewerIsAdmin: boolean;
  canParticipate: boolean;
  feed: FeedEntry[];
  activity: ActivityDoc[];
  feedLoading: boolean;
};

export default function CommentThread({
  task,
  users,
  viewerUid,
  viewerIsAdmin,
  canParticipate,
  feed,
  activity,
  feedLoading,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <ActivityFeed
        task={task}
        users={users}
        viewerUid={viewerUid}
        viewerIsAdmin={viewerIsAdmin}
        feed={feed}
        loading={feedLoading}
      />
      {canParticipate && (
        <CommentComposer mode="create" task={task} users={users} activity={activity} />
      )}
    </div>
  );
}
