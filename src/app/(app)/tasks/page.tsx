"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { useMembers } from "@/features/admin/useMembers";
import { useProjects } from "@/features/admin/useProjects";
import TaskDetailModal from "@/features/tasks/components/TaskDetailModal";
import TaskList from "@/features/tasks/components/TaskList";
import { useTasks } from "@/features/tasks/hooks/useTasks";
import { createTask } from "@/features/tasks/taskMutations";
import { isOverdue } from "@/lib/firestore/tasks";

type Tab = "due-soon" | "all-open" | "completed";

export default function MyWorkPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openTaskId = searchParams.get("task");

  const { user, role } = useAuth();
  const { tasks, loading } = useTasks(user ? { assigneeUid: user.uid, includeArchived: false } : {});
  const { projects } = useProjects();
  const { users } = useMembers();

  const [tab, setTab] = useState<Tab>("due-soon");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  const { dueSoon, allOpen, completed } = useMemo(() => {
    const open = tasks.filter((t) => t.status !== "done");
    const sortedDueSoon = [...open].sort((a, b) => {
      const ao = isOverdue(a) ? 0 : 1;
      const bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      if (a.dueDate && b.dueDate) return a.dueDate.getTime() - b.dueDate.getTime();
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });
    return {
      dueSoon: sortedDueSoon,
      allOpen: open,
      completed: tasks.filter((t) => t.status === "done"),
    };
  }, [tasks]);

  function openTask(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("task", id);
    router.replace(`/tasks?${params.toString()}`);
  }
  function closeTask() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("task");
    const qs = params.toString();
    router.replace(qs ? `/tasks?${qs}` : "/tasks");
  }

  async function handleQuickAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!quickTitle.trim() || !user) return;
    setQuickBusy(true);
    try {
      await createTask({
        title: quickTitle.trim(),
        source: "personal",
        assigneeUids: [user.uid],
        visibility: "assignees-only",
      });
      setQuickTitle("");
    } catch (err) {
      console.error(err);
    } finally {
      setQuickBusy(false);
    }
  }

  if (!user || !role) return null;

  const visible = tab === "due-soon" ? dueSoon : tab === "all-open" ? allOpen : completed;

  return (
    <div>
      <div style={{ marginBottom: "var(--space-5)" }}>
        <Badge tone="accent">My work</Badge>
        <h1 style={{ marginTop: "var(--space-2)" }}>Your tasks</h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-1)" }}>
          Everything assigned to you: committee work, fellowship reminders, and your own to-dos.
        </p>
      </div>

      <Card padding="md" style={{ marginBottom: "var(--space-4)" }}>
        <form onSubmit={handleQuickAdd} style={{ display: "flex", gap: "var(--space-2)" }}>
          <Input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="Quick add — a personal task for you"
            maxLength={120}
            style={{ flex: 1 }}
          />
          <Button type="submit" disabled={!quickTitle.trim() || quickBusy}>
            {quickBusy ? "Adding…" : "Add"}
          </Button>
        </form>
      </Card>

      <div
        role="tablist"
        style={{
          display: "flex",
          gap: "var(--space-2)",
          marginBottom: "var(--space-4)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <TabButton active={tab === "due-soon"} onClick={() => setTab("due-soon")} count={dueSoon.length}>
          Due soon
        </TabButton>
        <TabButton active={tab === "all-open"} onClick={() => setTab("all-open")} count={allOpen.length}>
          All open
        </TabButton>
        <TabButton active={tab === "completed"} onClick={() => setTab("completed")} count={completed.length}>
          Completed
        </TabButton>
      </div>

      {loading ? (
        <p style={{ color: "var(--color-text-muted)" }}>Loading tasks…</p>
      ) : (
        <TaskList
          tasks={visible}
          projects={projects}
          users={users}
          onOpenTask={openTask}
          showQuickComplete={tab !== "completed"}
          emptyMessage={
            tab === "completed" ? "Nothing completed yet." : "You're all caught up."
          }
        />
      )}

      {openTaskId && (
        <TaskDetailModal
          taskId={openTaskId}
          viewerUid={user.uid}
          viewerRole={role}
          projects={projects}
          users={users}
          onClose={closeTask}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "var(--space-2) var(--space-3)",
        background: "transparent",
        border: "none",
        color: active ? "var(--color-text)" : "var(--color-text-muted)",
        borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
        fontSize: "var(--text-sm)",
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        marginBottom: "-1px",
      }}
    >
      {children}
      <span style={{ marginLeft: "var(--space-1)", color: "var(--color-text-subtle)" }}>
        {count}
      </span>
    </button>
  );
}
