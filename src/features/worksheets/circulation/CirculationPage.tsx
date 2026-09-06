"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Chip from "@/components/ui/Chip";
import EmptyState from "@/components/ui/EmptyState";
import MemberName, { MEMBER_NAME_FALLBACK } from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import Skeleton from "@/components/ui/Skeleton";
import { useTaskRoster } from "@/features/tasks/hooks/useTaskRoster";
import { CIRCULATION_LIMITS } from "@/lib/firestore/circulations";
import { useCirculation } from "../hooks/useCirculation";
import { useCirculationResponses } from "../hooks/useCirculationResponses";
import RecipientPicker from "./RecipientPicker";
import RecipientRow, { RecipientTableHeader } from "./RecipientRow";
import ResponseView from "./ResponseView";
import {
  CIRCULATION_SORT_OPTIONS,
  reviewConfigSummary,
  sortResponses,
  submittedTally,
  type CirculationSortKey,
} from "./circulationView";
import { notificationSummaryOf } from "./notificationCopy";
import { useRecipientCandidates, type RecipientCandidate } from "./useRecipientCandidates";
import styles from "./CirculationPage.module.css";

/**
 * The sender's view of one circulation: who has it, how far they are, and what
 * they wrote.
 *
 * ── A STAFF SURFACE, AND THE RULES SAY SO RATHER THAN THIS FILE ─────────────
 * A recipient can READ the circulation document (they prove themselves with
 * their own response), but not list the responses subcollection: the owner
 * branch of that rule is per-document-id, which a query cannot constrain, so
 * one recipient can never enumerate what the others wrote. That is why the
 * responses hook is held on `null` until the viewer is known to be staff.
 * Attaching it for a recipient would not leak anything; it would produce a
 * permission error on a page that then had nothing to say about why.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * NAMES COME FROM TWO ROUTES, never from the `users` collection. Staff here
 * may be an ordinary committee member holding `circulateWorksheet` and nothing
 * else, who cannot read `users` at all.
 *
 * `useTaskRoster` answers for everybody on a task the VIEWER is on, which
 * covers the reviewer the sender named: every recipient is a completer on a
 * task they review. It does not cover two staff who are staff for another
 * reason. The worksheet's author is staff by authorship, and an admin is staff
 * by being an admin, and neither is necessarily on any of these tasks, so for
 * them the roster answers nothing and every row would read "NAISI member" on a
 * page whose whole job is saying who has done the work. The recipients route
 * fills that gap: it serves the committee roster to any holder of
 * `circulateWorksheet` (admins implicit), which is exactly those two people in
 * the cases that matter. An author holding no key still sees the fallback;
 * that residue needs the roster route widened, not a `users` read here.
 *
 * Export, Close and mid-flight editing of the questions are wave 2. They are
 * rendered disabled rather than hidden: a sender who cannot find the export
 * button assumes there is no export, and goes and builds a spreadsheet by
 * hand.
 */

const NEXT_WAVE_TITLE = "Coming in the next wave.";

type Props = {
  worksheetId: string;
  circulationId: string;
};

export default function CirculationPage({ worksheetId, circulationId }: Props) {
  const { user, role, permissions } = useAuth();
  const uid = user?.uid ?? null;
  const isAdmin = role === "admin";

  const { circulation, loading, error } = useCirculation(circulationId);

  const isStaff = Boolean(circulation && uid && (isAdmin || circulation.staffUids.includes(uid)));
  const canCirculate = isAdmin || Boolean(permissions.circulateWorksheet);

  const {
    responses,
    loading: responsesLoading,
    error: responsesError,
  } = useCirculationResponses(isStaff ? circulationId : null);

  /**
   * The second name source, and the list the Add-recipients dialog picks from.
   * Held here rather than inside that dialog so one fetch serves both: the
   * dialog is opened by the same person who is already reading these names.
   * Asked for only where the route will answer, since it refuses anybody
   * without `circulateWorksheet` and a 403 is not a name.
   */
  const {
    candidates,
    loading: candidatesLoading,
    error: candidatesError,
  } = useRecipientCandidates(isStaff && canCirculate);

  const { users } = useTaskRoster();
  const nameByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of users) {
      if (member.displayName) map.set(member.uid, member.displayName);
    }
    // Second, and only where the first had nothing: the roster is the closer
    // relationship (these are people the viewer shares a task with), so it wins
    // any disagreement about what somebody is called.
    for (const candidate of candidates) {
      if (!map.has(candidate.uid) && candidate.displayName) {
        map.set(candidate.uid, candidate.displayName);
      }
    }
    return map;
  }, [candidates, users]);
  const nameOf = useCallback(
    (memberUid: string) => nameByUid.get(memberUid) ?? MEMBER_NAME_FALLBACK,
    [nameByUid],
  );

  const [sortKey, setSortKey] = useState<CirculationSortKey>("added");
  const [viewingUid, setViewingUid] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const sorted = useMemo(
    () => sortResponses(responses, sortKey, nameOf),
    [responses, sortKey, nameOf],
  );
  const tally = useMemo(() => submittedTally(responses), [responses]);
  const viewing = useMemo(
    () => (viewingUid ? (responses.find((r) => r.uid === viewingUid) ?? null) : null),
    [responses, viewingUid],
  );

  if (loading) {
    return (
      <div className={styles.loading}>
        <Skeleton width="14rem" height="1.75rem" ariaLabel="Loading this circulation…" />
        <Skeleton width="100%" height="4rem" radius="var(--radius-md)" ariaLabel="" />
        <Skeleton width="100%" height="4rem" radius="var(--radius-md)" ariaLabel="" />
      </div>
    );
  }

  // A REFUSED READ AND A MISSING DOCUMENT ARE THE SAME SCREEN, because from
  // here they are the same fact. The circulations read rule dereferences
  // `resource.data.staffUids`, and on a document that does not exist
  // `resource` is null, so a mistyped or deleted id comes back as
  // permission-denied rather than as an empty snapshot. Reporting Firestore's
  // own sentence ("Missing or insufficient permissions.") would tell somebody
  // their access was refused when the circulation simply is not there, and this
  // page cannot tell the two apart. Every other failure (a dropped connection,
  // say) still reports itself, because that one the reader can act on.
  const refused = (error as { code?: string } | null)?.code === "permission-denied";

  if (error && !refused) {
    return (
      <EmptyState
        title="Couldn't open this circulation"
        body={error.message}
        action={
          <Link href="/worksheets" className={styles.linkButton}>
            Back to worksheets
          </Link>
        }
      />
    );
  }

  if (refused || !circulation) {
    return (
      <EmptyState
        title="That circulation isn't here"
        body="It may have been removed, the link may be wrong, or it may be one you have no part in. If this worksheet was sent to you, your own copy is on your task."
        action={
          <Link href="/worksheets" className={styles.linkButton}>
            Back to worksheets
          </Link>
        }
      />
    );
  }

  if (!isStaff) {
    return (
      <EmptyState
        title="This page is for the people running this circulation"
        body="If this worksheet was sent to you, your own copy is on your task, and answering it is a different page."
        action={
          <Link href={`/worksheets/respond/${circulationId}`} className={styles.linkButton}>
            Open my copy
          </Link>
        }
      />
    );
  }

  const senderName = uid === circulation.senderUid ? "you" : nameOf(circulation.senderUid);
  const sentOn = circulation.createdAt
    ? circulation.createdAt.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "an unrecorded date";
  const due = circulation.dueDate
    ? `due ${circulation.dueDate.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })}`
    : "no due date";

  const reviewSummary = reviewConfigSummary(circulation.reviewConfig);
  const notificationSummary = notificationSummaryOf(circulation.notifications);
  const existingRecipientUids = responses.map((response) => response.uid);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headTop}>
          <Badge tone="accent">Circulation</Badge>
          <Chip size="sm" tone={circulation.status === "open" ? "accent" : "neutral"}>
            {circulation.status === "open" ? "Open" : "Closed"}
          </Chip>
        </div>
        <h1 className={styles.title}>{circulation.title}</h1>
        <p className={styles.meta}>
          Sent by {senderName} on {sentOn}, {due}.
        </p>
        <p className={styles.tally}>
          {tally.submitted} of {tally.total} submitted
        </p>
      </header>

      <div className={styles.actions}>
        {canCirculate && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setAddOpen(true)}
            disabled={circulation.status === "closed"}
            title={
              circulation.status === "closed"
                ? "This circulation is closed, so nobody else can be added to it."
                : undefined
            }
          >
            Add recipients
          </Button>
        )}
        <Link
          href={`/worksheets/${worksheetId}`}
          className={styles.linkButton}
          title="Editing the questions this circulation already sent lands in the next wave. This opens the library worksheet."
        >
          Edit copy
        </Link>
        {/* Disabled buttons swallow their own mouse events in some browsers, so
            the tooltip rides on a wrapper rather than on the button. */}
        <span title={NEXT_WAVE_TITLE}>
          <Button type="button" variant="secondary" disabled>
            Export
          </Button>
        </span>
        <span title={NEXT_WAVE_TITLE}>
          <Button type="button" variant="secondary" disabled>
            Close
          </Button>
        </span>
      </div>

      <div className={styles.body}>
        <section className={styles.main} aria-label="Recipients">
          <div className={styles.tableBar}>
            <h2 className={styles.sectionTitle}>Recipients</h2>
            <span className={styles.sortField}>
              <ResponsiveSelect
                value={sortKey}
                onChange={(next) => setSortKey(next as CirculationSortKey)}
                options={CIRCULATION_SORT_OPTIONS}
                ariaLabel="Sort recipients"
              />
            </span>
          </div>

          {responsesError && (
            <p className={styles.error} role="status">
              Couldn&apos;t load the recipients: {responsesError.message}
            </p>
          )}

          {responsesLoading && responses.length === 0 ? (
            <div className={styles.loading}>
              <Skeleton
                width="100%"
                height="3.5rem"
                radius="var(--radius-md)"
                ariaLabel="Loading recipients…"
              />
              <Skeleton width="100%" height="3.5rem" radius="var(--radius-md)" ariaLabel="" />
            </div>
          ) : responses.length === 0 ? (
            <EmptyState
              title="Nobody has this yet"
              body="Add the people who should answer it and they each get their own copy and their own task."
              action={
                canCirculate ? (
                  <Button type="button" onClick={() => setAddOpen(true)}>
                    Add recipients
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              <RecipientTableHeader />
              <ul className={styles.rows}>
                {sorted.map((response) => (
                  <RecipientRow
                    key={response.uid}
                    response={response}
                    name={nameOf(response.uid)}
                    onView={() => setViewingUid(response.uid)}
                  />
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className={styles.side} aria-label="How this circulation is set up">
          <Card as="section" padding="md" className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Reviewers</h2>
            {circulation.reviewerUids.length === 0 ? (
              <p className={styles.sideEmpty}>Nobody was named as a reviewer.</p>
            ) : (
              <ul className={styles.sideList}>
                {circulation.reviewerUids.map((reviewerUid) => (
                  <li key={reviewerUid} className={styles.sideItem}>
                    <MemberName name={nameByUid.get(reviewerUid)} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card as="section" padding="md" className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Review</h2>
            {reviewSummary.length === 0 ? (
              <p className={styles.sideEmpty}>
                No feedback and no scoring. Answers are read, and nothing goes back.
              </p>
            ) : (
              <ul className={styles.sideList}>
                {reviewSummary.map((line) => (
                  <li key={line} className={styles.sideItem}>
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card as="section" padding="md" className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Notifications</h2>
            {notificationSummary.length === 0 ? (
              <p className={styles.sideEmpty}>Nothing is sent for this circulation.</p>
            ) : (
              <ul className={styles.sideList}>
                {notificationSummary.map((row) => (
                  <li key={row.event} className={styles.sideItem}>
                    {row.label}: {row.channels}
                  </li>
                ))}
              </ul>
            )}
            {/* Read-only in this wave. Changing them after the fact means
                deciding what a person already told about a message should be
                told when it is turned off, which is a wave-2 question. */}
            <p className={styles.sideNote}>
              These were set when the worksheet went out. Changing them later lands in
              the next wave.
            </p>
          </Card>
        </aside>
      </div>

      {viewing && (
        <ResponseView
          circulation={circulation}
          response={viewing}
          name={nameOf(viewing.uid)}
          onClose={() => setViewingUid(null)}
        />
      )}

      {addOpen && (
        <AddRecipientsDialog
          circulationId={circulationId}
          candidates={candidates}
          candidatesLoading={candidatesLoading}
          candidatesError={candidatesError}
          excludeUids={existingRecipientUids}
          nameOf={nameOf}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add recipients
// ---------------------------------------------------------------------------

/**
 * A second use of the same picker, in a dialog of its own.
 *
 * The list arrives as a prop rather than being fetched here. The page above is
 * already holding it (it is one of the two things that stop this table reading
 * "NAISI member" all the way down), and fetching a second copy on open would
 * be a second authorisation of a roster this person has already been given.
 *
 * People who already have this circulation are EXCLUDED from the list rather
 * than shown ticked. The route skips them anyway (it answers with a `skipped`
 * array), but a ticked row that does nothing invites the reader to untick it,
 * and unticking cannot take a worksheet back off somebody.
 */
function AddRecipientsDialog({
  circulationId,
  candidates,
  candidatesLoading,
  candidatesError,
  excludeUids,
  nameOf,
  onClose,
}: {
  circulationId: string;
  candidates: RecipientCandidate[];
  candidatesLoading: boolean;
  candidatesError: string | null;
  excludeUids: string[];
  nameOf: (uid: string) => string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; skipped: string[] } | null>(null);

  async function add() {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulationId)}/recipients`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipientUids: selected }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { added?: number; skipped?: string[]; error?: string }
        | null;
      if (!res.ok) {
        setAddError(body?.error ?? `Couldn't add anybody (${res.status}).`);
        setBusy(false);
        return;
      }
      setResult({ added: body?.added ?? 0, skipped: body?.skipped ?? [] });
      setSelected([]);
      setBusy(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add anybody.");
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} ariaLabel="Add recipients" width="md">
      <div className={styles.dialog}>
        <h2 className={styles.dialogTitle}>Add recipients</h2>
        <p className={styles.dialogNote}>
          Everyone you add gets their own copy of the questions as they stand now, and
          their own task.
        </p>

        <RecipientPicker
          candidates={candidates}
          loading={candidatesLoading}
          error={candidatesError}
          selected={selected}
          onChange={setSelected}
          ariaLabel="People to add"
          excludeUids={excludeUids}
          max={CIRCULATION_LIMITS.maxRecipientsPerRequest}
          disabled={busy}
        />

        {result && (
          <p className={styles.dialogResult} role="status">
            Added {result.added} {result.added === 1 ? "person" : "people"}.
            {result.skipped.length > 0 &&
              ` Skipped ${result.skipped.map(nameOf).join(", ")}: they already had it.`}
          </p>
        )}

        {addError && (
          <p className={styles.error} role="status">
            {addError}
          </p>
        )}

        <footer className={styles.dialogFooter}>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {result ? "Done" : "Cancel"}
          </Button>
          <Button type="button" onClick={add} disabled={busy || selected.length === 0}>
            {busy
              ? "Adding…"
              : `Add ${selected.length} ${selected.length === 1 ? "person" : "people"}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
