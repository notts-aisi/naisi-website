"use client";

import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
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
  const projectOptions: ResponsiveSelectOption<TaskFilterState["projectId"]>[] = [
    { value: "all", label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];
  const personOptions: ResponsiveSelectOption<TaskFilterState["personUid"]>[] = [
    { value: "all", label: "All people" },
    ...users.map((u) => ({
      value: u.uid,
      label: u.displayName ?? u.email ?? u.uid,
    })),
  ];
  const sourceOptions: ResponsiveSelectOption<TaskFilterState["source"]>[] = [
    { value: "all", label: "All sources" },
    { value: "committee", label: "Committee" },
    { value: "fellowship-reminder", label: "Fellowship" },
    { value: "personal", label: "Personal" },
  ];
  const kindOptions: ResponsiveSelectOption<TaskFilterState["kind"]>[] = [
    { value: "all", label: "All kinds" },
    ...TASK_KINDS.map((k) => ({ value: k, label: TASK_KIND_LABELS[k] })),
  ];
  return (
    <div className={styles.grid}>
      <ResponsiveSelect<TaskFilterState["projectId"]>
        value={value.projectId}
        onChange={(next) => onChange({ ...value, projectId: next })}
        options={projectOptions}
        ariaLabel="Filter by project"
      />
      <ResponsiveSelect<TaskFilterState["personUid"]>
        value={value.personUid}
        onChange={(next) => onChange({ ...value, personUid: next })}
        options={personOptions}
        ariaLabel="Filter by person (completer or reviewer)"
      />
      <ResponsiveSelect<TaskFilterState["source"]>
        value={value.source}
        onChange={(next) => onChange({ ...value, source: next })}
        options={sourceOptions}
        ariaLabel="Filter by source"
      />
      <ResponsiveSelect<TaskFilterState["kind"]>
        value={value.kind}
        onChange={(next) => onChange({ ...value, kind: next })}
        options={kindOptions}
        ariaLabel="Filter by kind"
      />
    </div>
  );
}
