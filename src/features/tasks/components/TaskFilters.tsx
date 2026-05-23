"use client";

import { Select } from "@/components/ui/Input";
import type { ProjectDoc } from "@/lib/firestore/projects";
import type { UserDoc } from "@/lib/firestore/users";
import { TASK_KINDS, TASK_KIND_LABELS, type TaskKind } from "@/lib/firestore/tasks";
import styles from "./TaskFilters.module.css";

export type TaskFilterState = {
  projectId: string | "all";
  /** Matches tasks where this uid is a completer OR a reviewer. */
  personUid: string | "all";
  source: "all" | "committee" | "fellowship-reminder" | "personal";
  kind: "all" | TaskKind;
};

type Props = {
  value: TaskFilterState;
  onChange: (next: TaskFilterState) => void;
  projects: ProjectDoc[];
  users: UserDoc[];
};

export default function TaskFilters({ value, onChange, projects, users }: Props) {
  return (
    <div className={styles.grid}>
      <Select
        value={value.projectId}
        onChange={(e) => onChange({ ...value, projectId: e.target.value as TaskFilterState["projectId"] })}
        aria-label="Filter by project"
      >
        <option value="all">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Select
        value={value.personUid}
        onChange={(e) => onChange({ ...value, personUid: e.target.value as TaskFilterState["personUid"] })}
        aria-label="Filter by person (completer or reviewer)"
      >
        <option value="all">All people</option>
        {users.map((u) => (
          <option key={u.uid} value={u.uid}>
            {u.displayName ?? u.email ?? u.uid}
          </option>
        ))}
      </Select>
      <Select
        value={value.source}
        onChange={(e) => onChange({ ...value, source: e.target.value as TaskFilterState["source"] })}
        aria-label="Filter by source"
      >
        <option value="all">All sources</option>
        <option value="committee">Committee</option>
        <option value="fellowship-reminder">Fellowship</option>
        <option value="personal">Personal</option>
      </Select>
      <Select
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value as TaskFilterState["kind"] })}
        aria-label="Filter by kind"
      >
        <option value="all">All kinds</option>
        {TASK_KINDS.map((k) => (
          <option key={k} value={k}>
            {TASK_KIND_LABELS[k]}
          </option>
        ))}
      </Select>
    </div>
  );
}
