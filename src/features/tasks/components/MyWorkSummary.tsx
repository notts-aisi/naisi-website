"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { useAuth } from "@/auth/AuthProvider";
import { useMembers } from "@/features/admin/useMembers";
import { useProjects } from "@/features/admin/useProjects";
import { isOverdue, type TaskDoc } from "@/lib/firestore/tasks";
import { useTasks } from "../hooks/useTasks";
import TaskDetailModal from "./TaskDetailModal";
import DueDateBadge from "./DueDateBadge";

export default function MyWorkSummary() {
  const { user, role } = useAuth();
  const { tasks } = useTasks(user ? { completerUid: user.uid } : {});
  const { projects } = useProjects();
  const { users } = useMembers();
  const [openId, setOpenId] = useState<string | null>(null);

  const open = useMemo(() => tasks.filter((t) => t.status !== "done"), [tasks]);
  const overdue = useMemo(() => open.filter((t) => isOverdue(t)), [open]);
  const upcoming = useMemo(
    () =>
      open
        .filter((t) => !isOverdue(t))
        .sort((a, b) => {
          if (a.dueDate && b.dueDate) return a.dueDate.getTime() - b.dueDate.getTime();
          if (a.dueDate) return -1;
          if (b.dueDate) return 1;
          return 0;
        })
        .slice(0, 5),
    [open],
  );

  if (!user || !role) return null;

  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-4)",
        gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
      }}
    >
      <Card padding="md">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
          <h3 style={{ fontSize: "var(--text-lg)", margin: 0 }}>Due soon</h3>
          <Link
            href="/tasks"
            style={{ fontSize: "var(--text-sm)", color: "var(--color-accent)" }}
          >
            View all →
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", margin: 0 }}>
            Nothing lined up. Nice.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {upcoming.map((t) => (
              <TaskRow key={t.id} task={t} onClick={() => setOpenId(t.id)} />
            ))}
          </ul>
        )}
      </Card>

      {overdue.length > 0 && (
        <Card padding="md" style={{ borderColor: "var(--color-danger)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
            <h3 style={{ fontSize: "var(--text-lg)", margin: 0 }}>Overdue</h3>
            <Badge tone="danger">{overdue.length}</Badge>
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {overdue.slice(0, 5).map((t) => (
              <TaskRow key={t.id} task={t} onClick={() => setOpenId(t.id)} />
            ))}
          </ul>
        </Card>
      )}

      <Card padding="md">
        <h3 style={{ fontSize: "var(--text-lg)", margin: 0, marginBottom: "var(--space-3)" }}>
          Open
        </h3>
        <p style={{ fontSize: "var(--text-3xl)", fontWeight: 700, margin: 0 }}>{open.length}</p>
        <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginTop: "var(--space-1)" }}>
          assigned to you
        </p>
      </Card>

      {openId && (
        <TaskDetailModal
          taskId={openId}
          viewerUid={user.uid}
          viewerRole={role}
          projects={projects}
          users={users}
          initialTask={tasks.find((t) => t.id === openId) ?? null}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function TaskRow({ task, onClick }: { task: TaskDoc; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "var(--space-2) var(--space-3)",
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--color-text)",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <span style={{ fontSize: "var(--text-sm)", flex: 1, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
          {task.title}
        </span>
        <DueDateBadge dueDate={task.dueDate} />
      </button>
    </li>
  );
}
