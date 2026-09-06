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
  /**
   * `course-register` DOES have an option below. The unmarked-register
   * follow-up is minted `visibility: "committee"` with the admins as its
   * completers (src/lib/courses/unmarkedRegisters.ts), so it already sits on
   * the board this filter narrows, and on an admin's My Work; the option only
   * lets a reader pull the register chases out from among everything else.
   *
   * `worksheet` is a member of this union with NO option in the dropdown
   * below, on purpose. The only page that mounts these filters is the
   * committee board, which loads `useTasks({ visibility: "committee" })`, and
   * every worksheet task is `assignees-only` (docs/worksheets.md), so
   * selecting it could only ever empty the board with no explanation. The
   * union member stays so the day a board that CAN show worksheet tasks
   * mounts this component, the filter state does not have to be widened at
   * the same time as the option is added.
   */
  source:
    | "all"
    | "committee"
    | "fellowship-reminder"
    | "personal"
    | "course-register"
    | "worksheet";
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
    // Register chases are committee-visibility, so this option narrows the
    // board rather than emptying it. The label matches TASK_SOURCE_LABELS.
    { value: "course-register", label: "Register" },
    // No "Worksheet" entry. See the note on TaskFilterState["source"]: an
    // option that is guaranteed to empty the board is worse than a missing
    // one, because the reader has no way to tell it apart from a board that
    // really has nothing on it.
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
