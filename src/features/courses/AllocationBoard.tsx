"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import { divergenceNote, type GroupDivergenceInput } from "@/lib/courses/groupResolve";
import {
  useAllocation,
  type AllocGroup,
  type AllocRow,
  type Placement,
} from "./useAllocation";
import styles from "./AllocationBoard.module.css";

/**
 * The group-allocation board for one course run.
 *
 * ── THE INVARIANT THIS SCREEN EXISTS TO MAKE VISIBLE ────────────────────────
 * A member's placement is ONE scalar (`courseEnrolments/{runId}__{uid}.groupId`)
 * on a doc whose id is derived from (run, uid). Double placement is not
 * "prevented" here — it is unrepresentable. Consequently:
 *
 *   - a group's membership is always a QUERY (`people.filter(p => p.groupId ===
 *     g.id)`), never a `memberUids` array, and nothing in this file may
 *     introduce one;
 *   - a "move" is one write, not a remove-then-add, so there is no window in
 *     which someone is in two groups or in none;
 *   - "everyone placed" is a count of `groupId == null`, which is why the
 *     status rail can state it as fact rather than as a reassurance.
 *
 * The rail says so out loud once the pool empties, because the whole point of
 * choosing the data model this way is lost if the person doing the allocation
 * still has to check by hand.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * ── PII ────────────────────────────────────────────────────────────────────
 * NAME-ONLY. The payload carries no email addresses (see the route), and this
 * component builds no address from anything — no mailto, no uid-to-user read.
 * Track leads and facilitators are ordinary members; handing them a cohort's
 * addresses is not something anybody consented to. Reviewer notes and answers
 * are member-authored and are rendered as TEXT NODES only.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * ── DRAG IS THE GARNISH, NOT THE MECHANISM ─────────────────────────────────
 * Every card carries a "Move to…" menu, and bulk mode moves a selection in one
 * transaction. Drag-and-drop is a third path over the same `place()` call.
 * That ordering is deliberate: allocation happens on a laptop at a table, on a
 * phone on a train, and with a keyboard, and a board that can only be operated
 * by dragging is a board that half the committee cannot use. The dnd path
 * therefore ships with a `KeyboardSensor` + `sortableKeyboardCoordinates` and
 * a full `announcements` config — correctness, not polish.
 * ───────────────────────────────────────────────────────────────────────────
 */

type Props = {
  /**
   * Only used to link back to the run editor from the no-groups empty state.
   * That link is admin-shaped; when P7 mounts this board on the learn side for
   * track leads, the href becomes a prop rather than a route built in here.
   */
  courseId: string;
  runId: string;
};

/** Column id for the unallocated pool. Not a group id — there is no such group. */
const UNALLOCATED = "__unallocated__";

/**
 * A board column, seen as `groupsDiverge` sees it (V2-3).
 *
 * THE UNALLOCATED POOL IS THE RUN CANONICAL. A column with no group behind it
 * is `null`, which `groupsDiverge` reads as the run canonical — exactly what an
 * unplaced member gets. So moving someone out of the pool into a group that has
 * overridden nothing raises no note, and into one that has, correctly does.
 *
 * `AllocGroup` now carries the three autonomy fields (`paceStartDate`,
 * `paceWeekPlan`, `forkedWeekIds`) in exactly `GroupDivergenceInput`'s shape,
 * so this is a projection and NOT a defaulting layer. It used to read them
 * through a `Partial<>` cast while the payload was still owed them — which
 * type-checked, silently answered "run canonical" for every column, and meant
 * the divergence note could not fire at all. A cast here is the thing that made
 * a disclosure look shipped while it was dead; if this ever needs one again,
 * the payload is what to fix.
 */
const autonomyOf = (group: AllocGroup | null): GroupDivergenceInput | null =>
  group
    ? {
        paceStartDate: group.paceStartDate,
        paceWeekPlan: group.paceWeekPlan,
        forkedWeekIds: group.forkedWeekIds,
      }
    : null;

/**
 * The one place a column id becomes the `groupId` the route stores. Module
 * scope so it cannot accidentally close over board state: the mapping is
 * total and has exactly one special case.
 */
const groupIdForColumn = (columnId: string): string | null =>
  columnId === UNALLOCATED ? null : columnId;

/** How many refusals to name in one toast before summarising the rest. */
const MAX_NAMED_REJECTIONS = 3;

/**
 * Cards never reorder WITHIN a column — the board has no per-group ordering to
 * persist, so a strategy that shuffles neighbours out of the way would be
 * animating a change that isn't going to happen. Cards are registered as
 * sortables anyway because `sortableKeyboardCoordinates` needs the dragged item
 * to be a droppable to compute its next position; this strategy is what stops
 * that registration from also implying a sort.
 */
const NO_REORDER: SortingStrategy = () => null;

const DRAG_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To move someone into another group, press space or enter on their drag handle, " +
    "use the arrow keys to reach the group you want, then press space or enter again to drop them. " +
    "Press escape to cancel. Every card also has a “Move to” menu that does the same thing without dragging.",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `prefers-reduced-motion`, read the `Dropdown` way (`useSyncExternalStore`, so
 * there is no set-state-in-effect and the server snapshot is deterministic).
 * Motion is a preference the OS already knows; we only ever read it.
 */
const reducedMotionQuery = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribeReducedMotion = (cb: () => void) => {
  const mq = reducedMotionQuery();
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getReducedMotion = () => reducedMotionQuery().matches;
const getReducedMotionServer = () => false;

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getReducedMotionServer,
  );
}

/** Client-only render (data arrives from a fetch), so no SSR/CSR skew. */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "Ada, Grace and Alan" — a list a human reads, not a comma-joined dump. */
function nameList(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

type CardFacts = {
  row: AllocRow;
  /** The group the card currently sits in, or null for the pool. */
  group: AllocGroup | null;
  /** Name of the group the reviewer suggested, when they suggested one. */
  preferredGroupName: string | null;
  /** True when a preference was recorded and this is NOT where they landed. */
  againstPreferredGroup: boolean;
  /** True when the reviewer named a facilitator this group doesn't have. */
  againstPreferredFacilitator: boolean;
  /**
   * They stated an availability and this group's session isn't in it. Only
   * ever true when they stated one — silence is not a conflict.
   */
  availabilityConflict: boolean;
};

/**
 * Everything derived about one card, in one place, so the card body and the
 * drag overlay cannot disagree about what the card says.
 */
function cardFacts(
  row: AllocRow,
  group: AllocGroup | null,
  groupsById: Map<string, AllocGroup>,
): CardFacts {
  const preferred = row.reviewerPreferredGroupId
    ? (groupsById.get(row.reviewerPreferredGroupId) ?? null)
    : null;
  const preferredName = row.reviewerPreferredGroupId
    ? (preferred?.name ?? "a group that no longer exists")
    : null;
  const facilitator = row.reviewerPreferredFacilitatorName;
  return {
    row,
    group,
    preferredGroupName: preferredName,
    againstPreferredGroup:
      row.reviewerPreferredGroupId !== null &&
      row.reviewerPreferredGroupId !== (group?.id ?? null),
    againstPreferredFacilitator:
      facilitator !== null &&
      group !== null &&
      !group.facilitatorNames.includes(facilitator),
    availabilityConflict:
      group !== null &&
      group.sessionLabel !== "" &&
      row.availability.length > 0 &&
      !row.availability.includes(group.sessionLabel),
  };
}

/**
 * The presentational half of a card. Rendered both in a column and inside the
 * `DragOverlay`, which is the reason it takes facts rather than deriving them.
 */
function PersonCardBody({
  facts,
  academicYear,
}: {
  facts: CardFacts;
  academicYear: string;
}) {
  const { row, group } = facts;
  const paidLabel = academicYear ? `Paid ${academicYear}` : "Paid member";

  return (
    <>
      <div className={styles.cardHead}>
        <span className={styles.name}>{row.displayName || "Applicant"}</span>
        <Badge tone={row.paidMembership ? "success" : "warning"}>
          {row.paidMembership ? paidLabel : "Unpaid"}
        </Badge>
      </div>

      {row.enrolmentStatus === "withdrawn" || row.enrolmentStatus === "removed" ? (
        <div className={styles.chips}>
          <Badge tone={row.enrolmentStatus === "removed" ? "danger" : "neutral"}>
            {row.enrolmentStatus === "removed" ? "Removed" : "Withdrawn"}
          </Badge>
        </div>
      ) : null}

      {row.availability.length > 0 ? (
        <ul className={styles.chips}>
          {row.availability.map((slot) => (
            /* The slot matching this card's own session is highlighted: it is
               the one fact that answers "can they actually come to this?". */
            <li
              key={slot}
              className={slot === group?.sessionLabel ? styles.chipOk : styles.chip}
            >
              {slot}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className={styles.chips}>
        {/* The conflict chip is the one that must be impossible to miss: it
            says this person told us they cannot make the session they are
            currently sitting in. */}
        {facts.availabilityConflict && group ? (
          <li className={styles.chipWarn}>
            Can&apos;t make {group.sessionLabel}
          </li>
        ) : null}
        {facts.preferredGroupName ? (
          <li
            className={
              facts.againstPreferredGroup ? styles.chipWarn : styles.chipOk
            }
          >
            {facts.againstPreferredGroup ? "Suggested: " : "As suggested: "}
            {facts.preferredGroupName}
          </li>
        ) : null}
        {row.reviewerPreferredFacilitatorName ? (
          /* Neutral while they're still in the pool: a preference that hasn't
             been acted on yet is neither honoured nor overridden. */
          <li
            className={
              group === null
                ? styles.chip
                : facts.againstPreferredFacilitator
                  ? styles.chipWarn
                  : styles.chipOk
            }
          >
            Facilitator: {row.reviewerPreferredFacilitatorName}
          </li>
        ) : null}
        {row.reviewerNotes ? (
          <li className={styles.chipNote} title={row.reviewerNotes}>
            Notes
            {/* `title` is mouse-only. The note itself is member-adjacent
                staff writing, so it goes to assistive tech in full. */}
            <span className={styles.srOnly}>: {row.reviewerNotes}</span>
          </li>
        ) : null}
        {row.allocatedEmailAt ? (
          <li className={styles.chipOk} title={`Emailed ${formatWhen(row.allocatedEmailAt)}`}>
            Emailed
          </li>
        ) : null}
      </ul>
    </>
  );
}

/**
 * A card in a column: the body above, plus the three things that make it
 * operable — a drag handle, a "Move to…" menu, and (in bulk mode) a checkbox.
 *
 * `Card` doesn't forward refs, so the sortable node is a wrapper `div` — the
 * same workaround `TaskBoard` uses, kept identical so the two boards don't
 * diverge into two different dnd idioms.
 */
function PersonCard({
  facts,
  columnId,
  academicYear,
  moveOptions,
  onMove,
  onRemove,
  bulkMode,
  selected,
  onToggleSelect,
  settling,
  reducedMotion,
  busy,
}: {
  facts: CardFacts;
  columnId: string;
  academicYear: string;
  moveOptions: DropdownOption[];
  onMove: (uid: string, columnId: string) => void;
  onRemove: (row: AllocRow) => void;
  bulkMode: boolean;
  selected: boolean;
  onToggleSelect: (uid: string) => void;
  settling: boolean;
  reducedMotion: boolean;
  busy: boolean;
}) {
  const { row } = facts;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.uid,
    data: { type: "person", columnId },
    // Reduced motion: no layout transition. The pointer-driven overlay stays —
    // it tracks the finger rather than animating on its own, so it is not the
    // kind of motion the preference is about.
    transition: reducedMotion ? null : undefined,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const className = [
    styles.card,
    isDragging ? styles.cardDragging : "",
    settling && !reducedMotion ? styles.cardSettling : "",
    selected ? styles.cardSelected : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={setNodeRef} style={style} className={styles.cardShell}>
      <Card padding="sm" className={className}>
        <PersonCardBody facts={facts} academicYear={academicYear} />

        <div className={styles.cardTools}>
          {bulkMode && (
            /* A bare <label> as hit area; the input carries its own
               `aria-label`, so adding label text as well would announce the
               name twice. */
            <label className={styles.selectBox}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(row.uid)}
                aria-label={`Select ${row.displayName || "this applicant"} for a bulk move`}
              />
            </label>
          )}

          <Dropdown
            value={columnId}
            onChange={(next) => onMove(row.uid, next)}
            options={moveOptions}
            disabled={busy}
            size="sm"
            /* Sheet at --bp-md so the popover never has to render inside an
               18rem column — the TaskCard precedent. */
            sheetBreakpoint="md"
            triggerPrefix="Move to"
            ariaLabel={`Move ${row.displayName || "this applicant"} to another group`}
          />

          {/* An enrolment can only be removed once it exists. Un-placing
              someone (Move to → Unallocated) is a different, softer thing:
              they stay on the run expecting a place. */}
          {row.enrolmentStatus === "active" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onRemove(row)}
              title={`Take ${row.displayName || "this applicant"} off this run`}
            >
              Remove
            </Button>
          )}

          <button
            type="button"
            className={styles.dragHandle}
            aria-label={`Drag ${row.displayName || "this applicant"} to another group`}
            title="Drag, or press space, to move between groups"
            {...(attributes as HTMLAttributes<HTMLButtonElement>)}
            {...listeners}
          >
            ≡
          </button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

function BoardColumn({
  columnId,
  group,
  rows,
  isHover,
  bulkMode,
  selectedUids,
  onSelectAll,
  children,
}: {
  columnId: string;
  /** null = the unallocated pool. */
  group: AllocGroup | null;
  rows: AllocRow[];
  isHover: boolean;
  bulkMode: boolean;
  selectedUids: Set<string>;
  onSelectAll: (uids: string[], select: boolean) => void;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `column-${columnId}`,
    data: { type: "column", columnId },
  });

  const isPool = group === null;
  const count = rows.length;
  const atCapacity = group?.capacity != null && count >= group.capacity;
  const allSelected =
    count > 0 && rows.every((r) => selectedUids.has(r.uid));

  const className = [
    styles.column,
    isPool ? (count > 0 ? styles.columnPool : styles.columnPoolEmpty) : "",
    isHover ? styles.columnHover : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={className} aria-label={isPool ? "Unallocated" : group.name}>
      <header className={styles.columnHead}>
        <div className={styles.columnTitleRow}>
          <h3 className={styles.columnTitle}>
            {isPool ? "Unallocated" : group.name}
          </h3>
          <span
            className={atCapacity ? styles.countFull : styles.count}
            title={
              group
                ? `${count} placed here on this board · server counter ${group.memberCount}`
                : undefined
            }
          >
            {isPool ? count : `${count}/${group.capacity ?? "∞"}`}
          </span>
        </div>
        {isPool ? (
          <p className={styles.columnMeta}>
            Accepted applicants with no group yet.
          </p>
        ) : (
          <>
            <p className={styles.columnMeta}>
              {group.sessionLabel || "No session time set"}
            </p>
            <p className={styles.columnMeta}>
              {group.facilitatorNames.length > 0
                ? nameList(group.facilitatorNames)
                : "No facilitator yet"}
            </p>
          </>
        )}
        {bulkMode && count > 0 && (
          <button
            type="button"
            className={styles.selectAll}
            onClick={() => onSelectAll(rows.map((r) => r.uid), !allSelected)}
          >
            {allSelected ? "Clear these" : `Select these ${count}`}
          </button>
        )}
      </header>

      <div ref={setNodeRef} className={styles.dropZone}>
        <SortableContext items={rows.map((r) => r.uid)} strategy={NO_REORDER}>
          {children}
        </SortableContext>
        {count === 0 && (
          <p className={styles.columnEmpty}>
            {isPool
              ? "Everyone has a group."
              : "No one here yet. Drop a card in, or use a card’s “Move to” menu."}
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export default function AllocationBoard({ courseId, runId }: Props) {
  const {
    data,
    loading,
    error,
    reload,
    place,
    publishAllocation,
    removeEnrolment,
  } = useAllocation(runId);
  const { toast, run: runAction, dismiss } = useActionToast();
  const reducedMotion = useReducedMotion();

  /**
   * Optimistic placement overrides, keyed by uid: set the instant a card is
   * dropped or a menu is used, cleared once the refetch agrees. Without this
   * the card snaps back to its origin column for the length of the round trip
   * (~200–600ms with a transaction), which reads as a failed drop.
   */
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [draggingUid, setDraggingUid] = useState<string | null>(null);
  const [hoverColumnId, setHoverColumnId] = useState<string | null>(null);
  const [settlingUid, setSettlingUid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Names the server (or this board) says still have no group. */
  const [unplacedNames, setUnplacedNames] = useState<string[]>([]);
  const [publishNote, setPublishNote] = useState<string | null>(null);

  const settleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const people = useMemo(() => data?.people ?? [], [data]);
  const groups = useMemo(() => data?.groups ?? [], [data]);

  const peopleByUid = useMemo(() => {
    const map = new Map<string, AllocRow>();
    for (const row of people) map.set(row.uid, row);
    return map;
  }, [people]);

  const groupsById = useMemo(() => {
    const map = new Map<string, AllocGroup>();
    for (const group of groups) map.set(group.id, group);
    return map;
  }, [groups]);

  /**
   * Prune any optimistic entry the refetch has already caught up to. Derived
   * per render rather than in an effect, so there is no cascading render —
   * `TaskBoard`'s idiom.
   */
  const activePending = useMemo(() => {
    const out: Record<string, string | null> = {};
    let changed = false;
    for (const [uid, groupId] of Object.entries(pending)) {
      const row = peopleByUid.get(uid);
      if (row && row.groupId !== groupId) out[uid] = groupId;
      else changed = true;
    }
    return changed ? out : pending;
  }, [peopleByUid, pending]);

  /** Column buckets. Order within a column is alphabetical — the board has no
   *  meaningful per-group ordering, and a stable one stops cards jumping. */
  const byColumn = useMemo(() => {
    const map = new Map<string, AllocRow[]>();
    map.set(UNALLOCATED, []);
    for (const group of groups) map.set(group.id, []);
    for (const row of people) {
      const groupId = row.uid in activePending ? activePending[row.uid] : row.groupId;
      // A placement into a group that has since been archived or deleted reads
      // as unplaced — which is the truth, and it keeps the pool honest as the
      // single list of "still to do".
      const bucket = (groupId && map.get(groupId)) || map.get(UNALLOCATED);
      bucket?.push(row);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return map;
  }, [people, groups, activePending]);

  // Memoised rather than read inline: the `?? []` fallback would otherwise
  // mint a fresh array every render and re-run everything downstream of it.
  const poolRows = useMemo(() => byColumn.get(UNALLOCATED) ?? [], [byColumn]);
  const acceptedCount = people.length;
  const unallocatedCount = poolRows.length;
  const placedCount = acceptedCount - unallocatedCount;
  const everyonePlaced = acceptedCount > 0 && unallocatedCount === 0;
  const progressPct =
    acceptedCount === 0 ? 0 : Math.round((placedCount / acceptedCount) * 100);

  /** Which column a uid is in right now, honouring optimistic overrides. */
  const columnIdOf = useCallback(
    (uid: string): string => {
      const row = peopleByUid.get(uid);
      if (!row) return UNALLOCATED;
      const groupId = uid in activePending ? activePending[uid] : row.groupId;
      return groupId && groupsById.has(groupId) ? groupId : UNALLOCATED;
    },
    [peopleByUid, activePending, groupsById],
  );

  const nameOf = useCallback(
    (uid: string) => peopleByUid.get(uid)?.displayName || "this applicant",
    [peopleByUid],
  );

  const columnNameOf = useCallback(
    (columnId: string) =>
      columnId === UNALLOCATED
        ? "Unallocated"
        : (groupsById.get(columnId)?.name ?? "that group"),
    [groupsById],
  );

  // Selection is derived-safe: a uid that vanished from the payload (their
  // application was withdrawn mid-session) must not stay silently selected.
  const liveSelection = useMemo(() => {
    const set = new Set<string>();
    for (const uid of selectedUids) if (peopleByUid.has(uid)) set.add(uid);
    return set;
  }, [selectedUids, peopleByUid]);

  const moveOptions = useMemo<DropdownOption[]>(
    () => [
      { value: UNALLOCATED, label: "Unallocated" },
      ...groups.map((group) => ({
        value: group.id,
        // Counts are the board's own, so the label agrees with the column
        // header the user is looking at. Options are never DISABLED at
        // capacity: the transaction is the authority on whether a group is
        // full, and a client-side guess would quietly hide a legitimate
        // over-allocation the allocator is entitled to attempt.
        label: `${group.name} · ${(byColumn.get(group.id) ?? []).length}/${group.capacity ?? "∞"}`,
      })),
    ],
    [groups, byColumn],
  );

  /**
   * ── THE DIVERGENCE DISCLOSURE (V2-3) ────────────────────────────────────
   * Groups can run their own calendar and their own forked copies of weeks, so
   * a MOVE is no longer only a change of room: it can change which week the
   * member is on, which version of the curriculum they read, and therefore
   * what their progress percentage means. None of that is visible on a card,
   * and the allocator is the last person who can catch it.
   *
   * `groupsDiverge` is the one helper that answers it — the same module every
   * content and calendar resolution goes through, so this note can never say
   * "identical" about two groups the learning space will render differently.
   *
   * The note is INFORMATIONAL AND NEVER BLOCKS. Moving someone into a group
   * that has personalised its weeks is a normal, intended act; the board's job
   * is to make sure it is not an accidental one. It replaces itself on the
   * next move and is dismissible, in the rail beside the tally rather than in
   * a toast, because a single move deliberately has no modal (see `commit`).
   */
  const [moveNote, setMoveNote] = useState<string | null>(null);

  /**
   * The sentence for one (origin → destination) pair, or null when the two
   * agree. Pure apart from the group lookup, so the bulk path can ask it once
   * per distinct origin and the single path once.
   */
  const divergenceMessage = useCallback(
    (fromColumnId: string, toColumnId: string, who: string): string | null => {
      // ONE helper, in the module that owns divergence — deliberately
      // conservative on the resolver's side (any fork on either side counts,
      // and a pace override counts even when it resolves to the same dates).
      // The board does not second-guess it: a spurious sentence costs an
      // allocator two seconds, and a missing one moves someone across a
      // curriculum boundary in silence.
      //
      // The two facts stay SEPARATE in the copy because they have different
      // consequences: pacing changes which week they are on TODAY, content
      // changes what that week contains. A note that merged them would be
      // wrong about one of them half the time.
      //
      // The board's ONLY job here is the labels — and the one that matters is
      // `target: null` for the pool, which is how `divergenceNote` knows not to
      // describe a column that has no weeks as though it had some. Everything
      // about WHICH SIDE diverges is the helper's, because getting that wrong
      // here is what made this note say three false things about the pool.
      return divergenceNote(
        autonomyOf(groupsById.get(fromColumnId) ?? null),
        autonomyOf(groupsById.get(toColumnId) ?? null),
        {
          source: columnNameOf(fromColumnId),
          target: toColumnId === UNALLOCATED ? null : columnNameOf(toColumnId),
          who,
        },
      );
    },
    [columnNameOf, groupsById],
  );

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  const revert = useCallback((uids: string[]) => {
    setPending((prev) => {
      const next = { ...prev };
      for (const uid of uids) delete next[uid];
      return next;
    });
  }, []);

  /**
   * `useActionToast` has no direct setter — the only way to raise its modal is
   * to give `run()` something that throws. Failures are the case that must be
   * unmissable, so this is the escape hatch for the quiet paths below, which
   * deliberately have no success toast to hang an error off.
   */
  const raiseError = useCallback(
    (message: string) =>
      runAction(async () => {
        throw new Error(message);
      }),
    [runAction],
  );

  /**
   * Send one batch, revert whatever didn't land, and return a sentence to show
   * the human (or null when it all went through). Never throws — an allocation
   * board has to be able to say WHICH group refused WHICH person, and a
   * rejected promise flattens that.
   */
  const runPlacements = useCallback(
    async (placements: Placement[]): Promise<string | null> => {
      const targets = new Map(placements.map((p) => [p.uid, p.groupId]));
      const result = await place(placements);
      if (!result.ok) {
        revert(placements.map((p) => p.uid));
        return result.error;
      }
      if (result.rejected.length === 0) return null;
      revert(result.rejected.map((r) => r.uid));
      // Name the GROUP that refused, not just the person: "full" is only
      // actionable if you know which room ran out of chairs.
      const named = result.rejected.slice(0, MAX_NAMED_REJECTIONS).map((r) => {
        const groupId = targets.get(r.uid) ?? null;
        const where = groupId
          ? (groupsById.get(groupId)?.name ?? "that group")
          : "the unallocated pool";
        return `${nameOf(r.uid)} → ${where} (${r.reason})`;
      });
      const extra = result.rejected.length - named.length;
      return (
        `${result.rejected.length} ${plural(result.rejected.length, "move was", "moves were")} refused: ` +
        `${named.join("; ")}${extra > 0 ? `, and ${extra} more` : ""}.`
      );
    },
    [place, revert, groupsById, nameOf],
  );

  /**
   * Optimistic placement, then the batch.
   *
   * `modal` is the toast-vs-inline decision, and it is NOT the plan's blanket
   * "allocate → ActionToast": `ActionToast` is a full-screen scrim that holds
   * for ~2s, and a single move is this board's WORKING MOTION — dragging forty
   * people through forty two-second modals is not a tool, it is a punishment.
   * A single move therefore reports itself by moving: the card lands, the
   * tally ticks, the bar grows, the pool shrinks. Deliberate acts that are hard
   * to eyeball — a bulk move, a removal, a publish — keep the modal, and every
   * FAILURE keeps it regardless.
   */
  const commit = useCallback(
    async (
      placements: Placement[],
      modal: { saving: string; success: string } | null,
    ) => {
      if (placements.length === 0) return;
      setPending((prev) => {
        const next = { ...prev };
        for (const p of placements) next[p.uid] = p.groupId;
        return next;
      });
      if (!modal) {
        const problem = await runPlacements(placements);
        if (problem) await raiseError(problem);
        return;
      }
      setBusy(true);
      try {
        await runAction(
          async () => {
            const problem = await runPlacements(placements);
            if (problem) throw new Error(problem);
          },
          { savingMessage: modal.saving, successMessage: modal.success },
        );
      } finally {
        setBusy(false);
      }
    },
    [runPlacements, raiseError, runAction],
  );

  /** Drag, keyboard drop, and the per-card menu all land here. */
  const moveOne = useCallback(
    (uid: string, columnId: string) => {
      const fromColumnId = columnIdOf(uid);
      if (fromColumnId === columnId) return;
      setMoveNote(divergenceMessage(fromColumnId, columnId, nameOf(uid)));
      void commit([{ uid, groupId: groupIdForColumn(columnId) }], null);
    },
    [columnIdOf, commit, divergenceMessage, nameOf],
  );

  const moveSelection = useCallback(
    (columnId: string) => {
      const moving = [...liveSelection].filter((uid) => columnIdOf(uid) !== columnId);
      const placements: Placement[] = moving.map((uid) => ({
        uid,
        groupId: groupIdForColumn(columnId),
      }));
      if (placements.length === 0) return;
      const n = placements.length;
      // A bulk move can cross several origin columns at once. ONE note, raised
      // for the first diverging origin: the point is "this destination is not
      // like where they came from", and twelve copies of that sentence is not
      // twelve times the warning. A selection where nothing diverges clears it.
      const who = n === 1 ? nameOf(moving[0]) : `those ${n} people`;
      let note: string | null = null;
      for (const from of new Set(moving.map(columnIdOf))) {
        note = divergenceMessage(from, columnId, who);
        if (note) break;
      }
      setMoveNote(note);
      const where = columnNameOf(columnId);
      setSelectedUids(new Set());
      void commit(placements, {
        saving: `Moving ${n} ${plural(n, "person", "people")}…`,
        success: `${n} ${plural(n, "person", "people")} → ${where}`,
      });
    },
    [liveSelection, columnIdOf, columnNameOf, commit, divergenceMessage, nameOf],
  );

  const handleRemove = useCallback(
    (row: AllocRow) => {
      const name = row.displayName || "this applicant";
      if (
        !window.confirm(
          `Take ${name} off this run?\n\n` +
            `Their enrolment ends and their place in ${columnNameOf(columnIdOf(row.uid))} is freed up. ` +
            `Their application and its decision are not changed, so they stay on this board and can be placed again.`,
        )
      ) {
        return;
      }
      setBusy(true);
      void (async () => {
        try {
          await runAction(
            async () => {
              const result = await removeEnrolment(row.uid);
              if (!result.ok) throw new Error(result.error);
            },
            {
              savingMessage: `Removing ${name}…`,
              successMessage: `${name} is off this run`,
            },
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [columnIdOf, columnNameOf, removeEnrolment, runAction],
  );

  /**
   * Publish. Two refusal paths, both landing in the STATUS RAIL rather than a
   * toast, because "who is still unplaced" is a work list you act on, not a
   * notification you dismiss:
   *
   *  1. The board already knows the pool is non-empty → refuse locally, name
   *     them in the rail, never call and never show the confirm dialog.
   *  2. The board thought it was done but the server disagreed (someone was
   *     accepted in another tab between the load and the click) → the route's
   *     409 carries the names, and they go in the same place.
   */
  const handlePublish = useCallback(() => {
    if (unallocatedCount > 0) {
      setPublishNote(null);
      setUnplacedNames(poolRows.map((r) => r.displayName || "Applicant"));
      return;
    }
    const label = data?.run.label ?? "this run";
    const already = data?.run.allocationPublishedAt != null;
    if (
      !window.confirm(
        `Publish the allocation for ${label}?\n\n` +
          `• ${placedCount} ${plural(placedCount, "member is", "members are")} enrolled in their group.\n` +
          `• Everyone newly placed is emailed their group, session time and facilitator.\n` +
          `• The cohort mailing list for this run is created so it can be emailed as one group.\n\n` +
          (already
            ? "This run has been published before — only people placed since then will be emailed."
            : "Emails cannot be un-sent."),
      )
    ) {
      return;
    }
    const conflict: { names: string[] } = { names: [] };
    setBusy(true);
    void (async () => {
      try {
        await runAction(
          async () => {
            const result = await publishAllocation();
            if (result.ok) {
              setUnplacedNames([]);
              setPublishNote(
                `Published — ${result.emailed} ${plural(result.emailed, "email", "emails")} sent` +
                  (result.skipped > 0
                    ? `, ${result.skipped} skipped (already had theirs).`
                    : "."),
              );
              return;
            }
            if (result.unplaced.length > 0) {
              conflict.names = result.unplaced;
              throw new Error(
                "Nothing was sent — some accepted applicants still have no group. They're listed above the board.",
              );
            }
            throw new Error(result.error);
          },
          {
            savingMessage: "Publishing allocation…",
            successMessage: "Allocation published — emails are on their way",
          },
        );
      } finally {
        setBusy(false);
        if (conflict.names.length > 0) {
          setPublishNote(null);
          setUnplacedNames(conflict.names);
        }
      }
    })();
  }, [
    unallocatedCount,
    poolRows,
    data,
    placedCount,
    publishAllocation,
    runAction,
  ]);

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // The correctness half: without a KeyboardSensor the board is mouse-only.
    // `sortableKeyboardCoordinates` walks the arrow keys between droppables,
    // which is why cards are registered as sortables at all.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Pointer-first detection, copied from `TaskBoard` for the same reason:
   * `closestCorners` measures rect-to-rect and routinely picks the next column
   * over when the dragged card overhangs by a few pixels. The pointer is
   * unambiguous. `pointerWithin` returns nothing under the KeyboardSensor
   * (there is no pointer), so the `closestCenter` fallback is also the keyboard
   * path — not just a gap-between-columns safety net.
   */
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerHits = pointerWithin(args);
    if (pointerHits.length > 0) {
      const personHit = pointerHits.find(
        (hit) => hit.data?.droppableContainer?.data?.current?.type === "person",
      );
      return personHit ? [personHit] : pointerHits;
    }
    return closestCenter(args);
  }, []);

  const columnIdFromOver = useCallback(
    (over: DragOverEvent["over"]): string | null => {
      // Cards and columns both carry `columnId`, so a drop on either resolves
      // to the same target — no "did I land on the card or the gap" class of bug.
      const overData = over?.data.current;
      if (overData?.type === "column" || overData?.type === "person") {
        return String(overData.columnId);
      }
      return null;
    },
    [],
  );

  /**
   * Screen-reader announcements. NAMES AND GROUP NAMES ONLY — dnd-kit's
   * defaults read out `active.id`, which here is a Firebase uid, and "Draggable
   * item aB3xK9… was moved over droppable area column-fri-1800" is not a
   * sentence anyone can act on.
   */
  const announcements = useMemo<Announcements>(() => {
    const placeName = (id: UniqueIdentifier | undefined): string => {
      if (id === undefined) return "no group";
      const raw = String(id);
      if (raw.startsWith("column-")) return columnNameOf(raw.slice("column-".length));
      return columnNameOf(columnIdOf(raw));
    };
    return {
      onDragStart: ({ active }) =>
        `Picked up ${nameOf(String(active.id))} from ${placeName(active.id)}. ` +
        `Use the arrow keys to choose a group, then press space to drop them.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${nameOf(String(active.id))} is over ${placeName(over.id)}.`
          : `${nameOf(String(active.id))} is not over a group.`,
      onDragEnd: ({ active, over }) =>
        over
          ? `${nameOf(String(active.id))} moved to ${placeName(over.id)}.`
          : `${nameOf(String(active.id))} was dropped outside a group and stayed where they were.`,
      onDragCancel: ({ active }) =>
        `Move cancelled. ${nameOf(String(active.id))} stayed in ${placeName(active.id)}.`,
    };
  }, [nameOf, columnNameOf, columnIdOf]);

  function handleDragStart(event: DragStartEvent) {
    const uid = String(event.active.id);
    setDraggingUid(uid);
    setHoverColumnId(columnIdOf(uid));
  }

  function handleDragOver(event: DragOverEvent) {
    setHoverColumnId(columnIdFromOver(event.over));
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingUid(null);
    setHoverColumnId(null);
    const { active, over } = event;
    if (!over) return;
    const uid = String(active.id);
    const target = columnIdFromOver(over);
    if (!target || target === columnIdOf(uid)) return;

    if (!reducedMotion) {
      setSettlingUid(uid);
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(() => {
        setSettlingUid((current) => (current === uid ? null : current));
        settleTimer.current = null;
      }, 320);
    }
    moveOne(uid, target);
  }

  function handleDragCancel() {
    setDraggingUid(null);
    setHoverColumnId(null);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // A failed FIRST load has nothing to fall back to; a failed refresh does, and
  // replacing a half-done allocation with an error card would throw away the
  // allocator's mental place in the list.
  if (error && !data) {
    return (
      <Card padding="lg">
        <p className={styles.error}>
          Couldn&apos;t load the allocation board: {error.message}
        </p>
        <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
          {loading ? "Retrying…" : "Try again"}
        </Button>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card padding="lg">
        <p className={styles.muted}>Loading the allocation board…</p>
      </Card>
    );
  }

  const { run } = data;
  const publishedAt = run.allocationPublishedAt;
  const draggingRow = draggingUid ? peopleByUid.get(draggingUid) : undefined;
  const selectedCount = liveSelection.size;

  const renderColumn = (columnId: string, group: AllocGroup | null) => {
    const rows = byColumn.get(columnId) ?? [];
    return (
      <BoardColumn
        key={columnId}
        columnId={columnId}
        group={group}
        rows={rows}
        isHover={hoverColumnId === columnId}
        bulkMode={bulkMode}
        selectedUids={liveSelection}
        onSelectAll={(uids, select) =>
          setSelectedUids((prev) => {
            const next = new Set(prev);
            for (const uid of uids) {
              if (select) next.add(uid);
              else next.delete(uid);
            }
            return next;
          })
        }
      >
        {rows.map((row) => (
          <PersonCard
            key={row.uid}
            facts={cardFacts(row, group, groupsById)}
            columnId={columnId}
            academicYear={run.academicYear}
            moveOptions={moveOptions}
            onMove={moveOne}
            onRemove={handleRemove}
            bulkMode={bulkMode}
            selected={liveSelection.has(row.uid)}
            onToggleSelect={(uid) =>
              setSelectedUids((prev) => {
                const next = new Set(prev);
                if (next.has(uid)) next.delete(uid);
                else next.add(uid);
                return next;
              })
            }
            settling={settlingUid === row.uid}
            reducedMotion={reducedMotion}
            busy={busy}
          />
        ))}
      </BoardColumn>
    );
  };

  return (
    <>
      <div className={styles.board}>
        {/* === Status rail ================================================= */}
        <div
          className={`${styles.rail} ${everyonePlaced ? styles.railDone : ""}`}
        >
          <div className={styles.railTop}>
            <div className={styles.railFacts}>
              <p className={styles.eyebrow}>
                {run.courseTitle || "Course"} · {run.label || "Untitled run"}
              </p>
              <p className={styles.tally} aria-live="polite">
                <strong>{acceptedCount}</strong> accepted ·{" "}
                <strong>{placedCount}</strong> placed ·{" "}
                <strong>{unallocatedCount}</strong> unallocated
              </p>
            </div>
            <div className={styles.railActions}>
              <Button
                variant="ghost"
                size="sm"
                onClick={reload}
                disabled={loading || busy}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setBulkMode((on) => !on);
                  setSelectedUids(new Set());
                }}
                aria-pressed={bulkMode}
              >
                {bulkMode ? "Done selecting" : "Select several"}
              </Button>
              <Button size="sm" onClick={handlePublish} disabled={busy}>
                Publish allocation
              </Button>
            </div>
          </div>

          <div
            className={styles.progress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            aria-valuetext={`${placedCount} of ${acceptedCount} accepted applicants placed`}
            aria-label="Accepted applicants placed in a group"
          >
            {/* scaleX, not width — a compositor-only property, and the bar sits
                in a sticky rail that must not force layout while scrolling. */}
            <span
              className={styles.progressFill}
              style={{ transform: `scaleX(${progressPct / 100})` }}
            />
          </div>

          {everyonePlaced ? (
            <p className={styles.railSuccess}>
              All {acceptedCount} accepted{" "}
              {plural(acceptedCount, "applicant is", "applicants are")} placed.
              No one is in two groups.
            </p>
          ) : acceptedCount === 0 ? (
            <p className={styles.muted}>
              Nobody has been accepted onto this run yet. Accepted applicants
              appear here for placement.
            </p>
          ) : null}

          {publishedAt ? (
            <p className={styles.railNote}>
              Published {formatWhen(publishedAt)}. Publishing again only emails
              people placed since then — nobody gets a second copy.
            </p>
          ) : null}

          {publishNote ? (
            <p className={styles.railSuccess} role="status">
              {publishNote}
            </p>
          ) : null}

          {/* The V2-3 divergence disclosure. `role="status"`, not `alert`:
              nothing has gone wrong, the move already happened, and it must
              not steal focus from an allocator mid-drag. It sits in the rail
              beside the tally the move just changed, and replaces itself on
              the next move. */}
          {moveNote ? (
            <p className={styles.railNote} role="status">
              {moveNote}{" "}
              <button
                type="button"
                className={styles.selectAll}
                onClick={() => setMoveNote(null)}
              >
                Dismiss
              </button>
            </p>
          ) : null}

          {/* The 409 (and the local refusal) land here, next to the count they
              contradict — not in a toast that vanishes. */}
          {unplacedNames.length > 0 ? (
            <div className={styles.conflict} role="alert">
              <p className={styles.conflictTitle}>
                {unplacedNames.length}{" "}
                {plural(unplacedNames.length, "person has", "people have")} no
                group, so nothing was published:
              </p>
              <p className={styles.conflictNames}>{nameList(unplacedNames)}</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setUnplacedNames([])}
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {error ? (
            <p className={styles.error} role="status">
              Couldn&apos;t refresh: {error.message} — showing the last version
              that loaded.
            </p>
          ) : null}
        </div>

        {/* === Columns ===================================================== */}
        {groups.length === 0 ? (
          <Card padding="lg">
            <h3 className={styles.emptyTitle}>No groups on this run yet</h3>
            <p className={styles.muted}>
              Add groups in the{" "}
              <Link
                className={styles.link}
                href={`/admin/courses/${encodeURIComponent(courseId)}/runs/${encodeURIComponent(runId)}`}
              >
                run editor
              </Link>{" "}
              — each one needs a session time and a facilitator — and they will
              appear here as columns to place people into.
            </p>
          </Card>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            accessibility={{
              announcements,
              screenReaderInstructions: DRAG_INSTRUCTIONS,
            }}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {/* Owns its own horizontal scroll. See CLAUDE.md §Main-area width:
                wide-data views handle their own responsiveness, and the
                min-width:0 chain (.board → .columns) is what stops the columns'
                intrinsic width propagating up to AppShell's grid track and
                giving the document a horizontal scrollbar. */}
            <div className={styles.columns}>
              {renderColumn(UNALLOCATED, null)}
              {groups.map((group) => renderColumn(group.id, group))}
            </div>

            <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
              {draggingRow ? (
                <div className={styles.overlay}>
                  <Card padding="sm" className={styles.card}>
                    <PersonCardBody
                      facts={cardFacts(
                        draggingRow,
                        groupsById.get(columnIdOf(draggingRow.uid)) ?? null,
                        groupsById,
                      )}
                      academicYear={run.academicYear}
                    />
                  </Card>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        {/* === Bulk footer ================================================= */}
        {bulkMode && selectedCount > 0 ? (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>
              {selectedCount} selected
            </span>
            <Dropdown
              /* An action menu, not a value: it always reads "Move to…" and
                 fires on pick. There is no "current group" for a mixed
                 selection, so there is nothing honest to show as selected. */
              value=""
              onChange={(next) => {
                if (next) moveSelection(next);
              }}
              options={[{ value: "", label: "Move to…" }, ...moveOptions]}
              disabled={busy}
              size="sm"
              sheetBreakpoint="md"
              ariaLabel={`Move the ${selectedCount} selected people to a group`}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedUids(new Set())}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </>
  );
}
