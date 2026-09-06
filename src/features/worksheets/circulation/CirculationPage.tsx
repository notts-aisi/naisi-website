"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import EmptyState from "@/components/ui/EmptyState";
import { MEMBER_NAME_FALLBACK } from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Skeleton from "@/components/ui/Skeleton";
import DestroyPanel from "@/features/destroy/DestroyPanel";
import { useTaskRoster } from "@/features/tasks/hooks/useTaskRoster";
import { CIRCULATION_LIMITS, type CirculationDoc } from "@/lib/firestore/circulations";
import { useCirculation } from "../hooks/useCirculation";
import { useCirculationResponses } from "../hooks/useCirculationResponses";
import AggregateView from "./AggregateView";
import CloseButton from "./CloseButton";
import CopyEditor from "./CopyEditor";
import ExportButton from "./ExportButton";
import RecipientPicker from "./RecipientPicker";
import RecipientRow, { RecipientTableHeader } from "./RecipientRow";
import ResponseView from "./ResponseView";
import SettingsPanel from "./SettingsPanel";
import {
  CIRCULATION_SORT_OPTIONS,
  sortResponses,
  submittedTally,
  type CirculationSortKey,
} from "./circulationView";
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
 * ── FOUR TABS, AND THE READ-ONLY RAIL BECAME ONE OF THEM ────────────────────
 * Wave 1 put the recipient table beside an 18rem rail summarising how the
 * circulation was set up, because nothing on it could be changed. Everything
 * on that rail is now editable in Settings, and carrying both would mean two
 * places saying what the review toggles are, one of which is a copy. So the
 * rail is gone, the table has the full width it wanted (it is five columns),
 * and the tabs are the four questions somebody opens this page to ask: who has
 * it, what did they say, what did we ask, and how is it set up.
 *
 * The tab lives in component state and not in the URL. A circulation page is
 * reached from a task, an email or the library, never linked to tab-first, and
 * a query parameter would be one more thing to keep in step for a view that
 * costs one click.
 */

type CirculationTab = "recipients" | "aggregate" | "copy" | "settings";

const TABS: { value: CirculationTab; label: string }[] = [
  { value: "recipients", label: "Recipients" },
  { value: "aggregate", label: "Aggregate" },
  { value: "copy", label: "Copy" },
  { value: "settings", label: "Settings" },
];

type Props = {
  worksheetId: string;
  circulationId: string;
};

export default function CirculationPage({ worksheetId, circulationId }: Props) {
  const router = useRouter();
  const { user, role, permissions } = useAuth();
  const uid = user?.uid ?? null;
  const isAdmin = role === "admin";

  const { circulation: liveCirculation, loading, error } = useCirculation(circulationId);
  const circulation = useCirculationThroughDestroy(liveCirculation);

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

  const [tab, setTab] = useState<CirculationTab>("recipients");
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

  // `refused` is folded into the null check rather than tested beside it: a
  // refused read hands the hook no document, so `!circulation` already covers
  // it, and testing `refused` separately would throw away the one document
  // this page is allowed to outlive (see `useCirculationThroughDestroy`).
  if (!circulation) {
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

  // A DESTROY IS RUNNING, and this is where everybody EXCEPT AN ADMIN stops.
  // The cascade sets `destroying` in the same write that closes the
  // circulation, before it deletes anything, so this is the first thing every
  // listen sees. Rendering the recipient table underneath it would show a list
  // emptying itself row by row, with every control on the page pointed at
  // documents that are going; and the page cannot be honest about what is
  // left, because by design it will shortly be nothing.
  //
  // AN ADMIN FALLS THROUGH, and it is not a courtesy: the danger zone at the
  // foot of this page is the ONLY circulation destroy panel in the app, and it
  // owns the progress view, the resume banner and the receipt. A cascade
  // bigger than one page budget returns `complete: false` and needs the same
  // panel to run the next pass, so unmounting it here on the listener's own
  // mid-cascade update would strand the circulation half destroyed with
  // nothing anywhere offering to finish it. The notice below says what is
  // happening; everything the notice describes as unusable is not rendered.
  //
  // Not a gate either way: the routes and the rules refuse the writes. This is
  // what the screen says while they do.
  if (circulation.destroying && !isAdmin) {
    return (
      <EmptyState
        title="This circulation is being removed"
        body="An admin is destroying it: the answers, the reviews and the cards it put on people's boards are being deleted, and this page will stop resolving when that finishes. Nothing here can be edited or exported any more."
        action={
          <Link href={`/worksheets/${worksheetId}`} className={styles.linkButton}>
            Open the library worksheet
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

  const closed = circulation.status === "closed";
  // Only an admin can reach this true (see the early return above), and from
  // here it means "render the notice and the danger zone, and nothing else".
  const destroying = circulation.destroying;
  const existingRecipientUids = responses.map((response) => response.uid);

  /* ADMIN ONLY, and it is the owner's decision rather than an oversight: a
     circulation destroy is offered to admins and never to the sender, because
     what it deletes is other people's answers. The routes behind the panel
     refuse everybody else, so this test is the manners and not the gate.

     Written as a value used by BOTH returns below, so there is exactly one
     mount of it. Two mounts would be two components, and the one mid-cascade
     would lose its progress state the moment the listener flipped the page
     from one branch to the other. */
  const dangerZone = isAdmin ? (
    <DestroyPanel
      kind="circulation"
      targetId={circulationId}
      label={circulation.title}
      nameLabel="circulation title"
      // The document's own counter, not the response listener's length: during
      // the cascade the subcollection is emptying, and a subtitle that counted
      // it would tell the admin the circulation had no recipients.
      subtitle={`Sent ${sentOn}, ${circulation.recipientCount} recipient${
        circulation.recipientCount === 1 ? "" : "s"
      }`}
      // The circulation document is gone by the time this fires, so there is
      // nothing on this page left to read: the library worksheet is the
      // nearest thing that still exists.
      onDestroyed={() => router.push(`/worksheets/${worksheetId}`)}
    />
  ) : null;

  // MID-DESTROY, FOR THE ADMIN RUNNING IT. Everything the notice calls unusable
  // is left out (the tabs, the export, the recipient table, the dialogs), and
  // the danger zone stays because it is the thing driving the cascade: the
  // progress view, the resume offer for a pass that ran out of budget, and the
  // receipt all live inside it.
  if (destroying) {
    return (
      <div className={styles.page}>
        <header className={styles.head}>
          <div className={styles.headTop}>
            <Badge tone="accent">Circulation</Badge>
            <Chip size="sm" tone="neutral">
              Being removed
            </Chip>
          </div>
          <h1 className={styles.title}>{circulation.title}</h1>
          <p className={styles.meta}>
            Sent by {senderName} on {sentOn}.
          </p>
        </header>

        <EmptyState
          title="This circulation is being removed"
          body="The answers, the reviews and the cards it put on people's boards are being deleted. Nothing here can be edited or exported any more. If the destroy stopped part-way, the danger zone below reports where it got to and offers to finish it."
          action={
            <Link href={`/worksheets/${worksheetId}`} className={styles.linkButton}>
              Open the library worksheet
            </Link>
          }
        />

        {dangerZone}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headTop}>
          <Badge tone="accent">Circulation</Badge>
          {/* The one piece of state that changes what every control on this
              page does, so it sits next to the title rather than inside the
              tab that closed it. */}
          <Chip size="sm" tone={closed ? "neutral" : "accent"}>
            {closed ? "Closed" : "Open"}
          </Chip>
        </div>
        <h1 className={styles.title}>{circulation.title}</h1>
        <p className={styles.meta}>
          Sent by {senderName} on {sentOn}, {due}.
        </p>
        <p className={styles.tally}>
          {tally.submitted} of {tally.total} submitted
        </p>
        {/* A DIFFERENT DOCUMENT from the one the Copy tab edits, and the words
            say which. This circulation carries its own copy of the questions;
            the library worksheet is the one every future circulation is made
            from, and editing it changes nothing here. */}
        <Link href={`/worksheets/${worksheetId}`} className={styles.headLink}>
          Open the library worksheet
        </Link>
      </header>

      <div className={styles.actions}>
        {/* HIDDEN once the circulation is closed rather than disabled. A
            disabled button with a tooltip is the right shape for something
            that might come back; nothing brings this one back, and the Chip
            beside the title has already said why. */}
        {canCirculate && !closed && (
          <Button type="button" variant="secondary" onClick={() => setAddOpen(true)}>
            Add recipients
          </Button>
        )}
        <ExportButton circulationId={circulationId} title={circulation.title} />
        <CloseButton circulation={circulation} />
      </div>

      <div className={styles.tabs}>
        <SegmentedControl
          value={tab}
          onChange={(next) => {
            // Reading one person's answers is an act of the recipient table.
            // Carrying that panel into the Aggregate tab would leave a modal
            // open over a page it has nothing to do with.
            setViewingUid(null);
            setTab(next);
          }}
          options={TABS}
          ariaLabel="What to show for this circulation"
        />
      </div>

      <div className={styles.body}>
        {tab === "recipients" && (
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
        )}

        {tab === "aggregate" && (
          <section className={styles.main} aria-label="Everybody's answers">
            {/* Counted from the documents already on screen rather than from
                the aggregate route: staff hold every response here, and the
                route exists for the recipient reading a poll's result, who
                cannot list the subcollection at all. */}
            <AggregateView circulation={circulation} responses={responses} nameOf={nameOf} loading={responsesLoading} />
          </section>
        )}

        {tab === "copy" && (
          <section className={styles.main} aria-label="The questions this circulation asks">
            <CopyEditor circulation={circulation} />
          </section>
        )}

        {tab === "settings" && (
          <section className={styles.main} aria-label="How this circulation is set up">
            <SettingsPanel circulation={circulation} nameOf={nameOf} isAdmin={isAdmin} />
          </section>
        )}
      </div>

      {dangerZone}

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
// Outliving the document
// ---------------------------------------------------------------------------

/**
 * The circulation as the page should render it, which for a destroy is NOT
 * quite what the listener last said.
 *
 * `useCirculation` is live, and the last thing a destroy does is delete the
 * document it is listening to. So at the exact moment the cascade succeeds the
 * snapshot arrives empty and the page would flip to "That circulation isn't
 * here", taking the receipt with it: the totals and the audit id are shown
 * nowhere else, the panel deliberately waits for the operator to press Done
 * before it navigates, and the operator would never see the button. An admin
 * would be left to work out from an empty page whether their destroy finished.
 *
 * So the LAST SNAPSHOT THAT WAS MID-DESTROY is kept and served after the
 * document goes. Two properties make that narrow rather than a stale cache:
 * the only document it can serve is one already flagged `destroying`, which
 * only the destroy engine writes, and it is only ever reached once the live
 * read has stopped answering. A circulation nobody destroyed still disappears
 * from this page the instant it disappears from Firestore, and so does one
 * whose read is refused for any other reason.
 */
function useCirculationThroughDestroy(live: CirculationDoc | null): CirculationDoc | null {
  // STATE, ADJUSTED DURING RENDER, which is the shape React documents for
  // "remember something about the value you were just given". The two shapes
  // that read more naturally are both refused, and rightly: a ref cannot be
  // read during render (`react-hooks/refs`), and a `setKept` inside an effect
  // is a second render pass for something already known in the first
  // (`react-hooks/set-state-in-effect`). The identity test is what stops it
  // looping: `live` is a fresh object per snapshot, and the circulation
  // document is written once during a destroy.
  const [kept, setKept] = useState<CirculationDoc | null>(null);
  if (live?.destroying && live !== kept) setKept(live);
  // The live document always wins. The kept one is only reachable once the
  // listener has stopped answering, and only if it was mid-destroy.
  return live ?? (kept?.destroying ? kept : null);
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
