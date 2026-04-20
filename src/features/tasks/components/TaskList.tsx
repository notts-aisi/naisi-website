"use client";

import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import type { TaskDoc } from "@/lib/firestore/tasks";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import TaskCard from "./TaskCard";
import { setTaskStatus } from "../taskMutations";

type Props = {
  tasks: TaskDoc[];
  projects: ProjectDoc[];
  users: UserDoc[];
  onOpenTask: (id: string) => void;
  /** If true, shows a 'Mark complete' one-click action inline on each row (for reminders). */
  showQuickComplete?: boolean;
  emptyMessage?: string;
};

export default function TaskList({
  tasks,
  projects,
  users,
  onOpenTask,
  showQuickComplete,
  emptyMessage,
}: Props) {
  if (tasks.length === 0) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
          {emptyMessage ?? "Nothing here yet."}
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {tasks.map((task) => (
        <div key={task.id} style={{ position: "relative" }}>
          <TaskCard task={task} projects={projects} users={users} onOpen={onOpenTask} />
          {showQuickComplete && task.status !== "done" && (
            <div
              style={{
                position: "absolute",
                top: "var(--space-3)",
                right: "var(--space-3)",
              }}
            >
              <Button
                size="sm"
                variant="secondary"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await setTaskStatus(task, "done");
                  } catch (err) {
                    console.error(err);
                  }
                }}
              >
                Mark done
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
