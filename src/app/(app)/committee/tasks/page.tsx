"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { useAuth } from "@/auth/AuthProvider";
import { useMembers } from "@/features/admin/useMembers";
import { useProjects } from "@/features/admin/useProjects";
import TaskBoard from "@/features/tasks/components/TaskBoard";
import TaskDetailModal from "@/features/tasks/components/TaskDetailModal";
import TaskFilters, {
  type TaskFilterState,
} from "@/features/tasks/components/TaskFilters";
import TaskForm from "@/features/tasks/components/TaskForm";
import { useTasks } from "@/features/tasks/hooks/useTasks";

export default function CommitteeTasksPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openTaskId = searchParams.get("task");

  const { user, role } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const { tasks, loading } = useTasks({ visibility: "committee", includeArchived: showArchived });
  const { projects } = useProjects();
  const { users } = useMembers();

  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState<TaskFilterState>({
    projectId: "all",
    personUid: "all",
    source: "all",
    kind: "all",
  });

  const archivedCount = useMemo(() => tasks.filter((t) => t.archived).length, [tasks]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (filters.projectId !== "all" && t.projectId !== filters.projectId) return false;
      if (filters.personUid !== "all") {
        const onTask =
          t.completerUids.includes(filters.personUid) ||
          t.reviewerUids.includes(filters.personUid);
        if (!onTask) return false;
      }
      if (filters.source !== "all" && t.source !== filters.source) return false;
      if (filters.kind !== "all" && t.kind !== filters.kind) return false;
      return true;
    });
  }, [tasks, filters]);

  function openTask(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("task", id);
    router.replace(`/committee/tasks?${params.toString()}`);
  }
  function closeTask() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("task");
    const qs = params.toString();
    router.replace(qs ? `/committee/tasks?${qs}` : "/committee/tasks");
  }

  if (!user || !role) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "var(--space-3)",
          flexWrap: "wrap",
          marginBottom: "var(--space-5)",
        }}
      >
        <div>
          <Badge tone="accent">Committee</Badge>
          <h1 style={{ marginTop: "var(--space-2)" }}>Task board</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-1)" }}>
            Drag cards between columns to update status. Click a card to open details.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New task</Button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          marginBottom: "var(--space-4)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: "16rem" }}>
          <TaskFilters value={filters} onChange={setFilters} projects={projects} users={users} />
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          <span>
            Show archived{showArchived && archivedCount > 0 ? ` (${archivedCount})` : ""}
          </span>
        </label>
      </div>

      {creating && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <TaskForm
            mode="committee"
            isAdmin={role === "admin"}
            projects={projects}
            users={users}
            currentUserUid={user.uid}
            onDone={() => setCreating(false)}
          />
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>Loading tasks…</p>
      ) : (
        <TaskBoard tasks={filtered} projects={projects} users={users} onOpenTask={openTask} />
      )}

      {openTaskId && (
        <TaskDetailModal
          key={openTaskId}
          taskId={openTaskId}
          viewerUid={user.uid}
          viewerRole={role}
          projects={projects}
          users={users}
          initialTask={filtered.find((t) => t.id === openTaskId) ?? null}
          onClose={closeTask}
        />
      )}
    </div>
  );
}
