"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import InitialsChip from "@/components/ui/InitialsChip";
import { Input } from "@/components/ui/Input";
import MemberName from "@/components/ui/MemberName";
import Skeleton from "@/components/ui/Skeleton";
import type { RecipientCandidate } from "./useRecipientCandidates";
import styles from "./RecipientPicker.module.css";

/**
 * Pick people, as a LIST rather than a dropdown.
 *
 * A dropdown is the right control for choosing one thing out of many. A sender
 * here is choosing several out of a couple of dozen, comparing them as they
 * go, and wants to see who is already ticked without reopening anything. So
 * this is a search box over a scrolling checkbox list, which is also the shape
 * that survives being put inside a dialog on a phone.
 *
 * PURE. The candidates arrive as a prop rather than being fetched here, so the
 * Circulate dialog can show the same list twice (recipients, then reviewers)
 * off ONE call to `GET /api/worksheets/recipients`. The fetch lives in
 * `useRecipientCandidates`.
 */

/**
 * Where a cap stops being a shape the sender is choosing within and starts
 * being a ceiling on the request.
 *
 * Five reviewers is a decision: the sender picks them one at a time, and a
 * "select all" button next to it would half-work and leave them working out
 * which five it took. A hundred recipients is a guard the route enforces
 * (`CIRCULATION_LIMITS.maxRecipientsPerRequest`), nowhere near what anybody is
 * picking by hand, so bulk selection is exactly what that list wants. One
 * number separates the two rather than a second prop nobody would remember to
 * pass.
 */
const SMALL_CAP_MAX = 10;

type Props = {
  candidates: RecipientCandidate[];
  loading: boolean;
  error: string | null;
  selected: string[];
  onChange: (next: string[]) => void;
  /** Labels the group for screen readers; every picker needs one. */
  ariaLabel: string;
  /**
   * Ticked, and not untickable. The sender in the reviewers picker: they can
   * always read what they sent (`staffUids` includes them whatever this list
   * says), so offering a tick that changes nothing would be a lie.
   */
  pinnedUids?: string[];
  /** Hidden entirely. The people a circulation already went to. */
  excludeUids?: string[];
  /**
   * Ceiling on the selection. Reached, the unticked rows go disabled, so a
   * sender learns about the limit here rather than from the route after
   * pressing Send.
   */
  max?: number;
  /** Single column, tighter rows. The reviewers picker inside the dialog. */
  compact?: boolean;
  disabled?: boolean;
};

export default function RecipientPicker({
  candidates,
  loading,
  error,
  selected,
  onChange,
  ariaLabel,
  pinnedUids = [],
  excludeUids = [],
  max,
  compact = false,
  disabled = false,
}: Props) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const excluded = new Set(excludeUids);
    return candidates.filter(
      (c) => !excluded.has(c.uid) && (!term || c.displayName.toLowerCase().includes(term)),
    );
  }, [candidates, excludeUids, search]);

  const pinned = useMemo(() => new Set(pinnedUids), [pinnedUids]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const atCap = typeof max === "number" && selected.length >= max;
  const capIsSmall = typeof max === "number" && max <= SMALL_CAP_MAX;

  function toggle(uid: string) {
    if (disabled || pinned.has(uid)) return;
    if (chosen.has(uid)) {
      onChange(selected.filter((u) => u !== uid));
      return;
    }
    if (atCap) return;
    onChange([...selected, uid]);
  }

  /**
   * Stops at the cap rather than sailing past it. Selecting two hundred people
   * into a request the route refuses at a hundred would move the refusal to
   * Send, which is the last place a sender can do anything about it.
   */
  function selectAllVisible() {
    const next = [...selected];
    for (const candidate of visible) {
      if (typeof max === "number" && next.length >= max) break;
      if (!next.includes(candidate.uid)) next.push(candidate.uid);
    }
    onChange(next);
  }

  function clearVisible() {
    const visibleUids = new Set(visible.map((c) => c.uid));
    onChange(selected.filter((uid) => pinned.has(uid) || !visibleUids.has(uid)));
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <Skeleton width="100%" height="2.5rem" ariaLabel="Loading the list of people…" />
        <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
        <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
        <Skeleton width="100%" height="2.75rem" radius="var(--radius-sm)" ariaLabel="" />
      </div>
    );
  }

  if (error) {
    return (
      <p className={styles.error} role="status">
        {error}
      </p>
    );
  }

  return (
    <div className={styles.picker}>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name…"
        aria-label={`Search ${ariaLabel.toLowerCase()}`}
        disabled={disabled}
      />

      <div className={styles.bar}>
        {/* "2 of 5 chosen" reads as a target, which is right for the reviewers
            list and wrong for a ceiling of a hundred that nobody is aiming at.
            The big cap is mentioned only once it actually bites. */}
        <span className={styles.count}>
          {capIsSmall ? `${selected.length} of ${max} chosen` : `${selected.length} chosen`}
          {atCap && !capIsSmall ? " (the most one send can take)" : ""}
        </span>
        {/* Bulk selection goes with the ceilings, not with the small caps: see
            SMALL_CAP_MAX. */}
        {!capIsSmall && (
          <span className={styles.barActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={selectAllVisible}
              disabled={disabled || visible.length === 0 || atCap}
            >
              Select all {visible.length}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearVisible}
              disabled={disabled || selected.length === 0}
            >
              Clear
            </Button>
          </span>
        )}
      </div>

      <div
        className={`${styles.list} ${compact ? styles.compact : ""}`}
        role="group"
        aria-label={ariaLabel}
      >
        {candidates.length === 0 && (
          <p className={styles.empty}>There is nobody here to send this to yet.</p>
        )}
        {candidates.length > 0 && visible.length === 0 && (
          <p className={styles.empty}>Nobody matches that search.</p>
        )}
        {visible.map((candidate) => {
          const isPinned = pinned.has(candidate.uid);
          const isChosen = isPinned || chosen.has(candidate.uid);
          const isDisabled = disabled || isPinned || (!isChosen && atCap);
          return (
            <label
              key={candidate.uid}
              className={`${styles.row} ${isChosen ? styles.rowChosen : ""} ${
                isDisabled ? styles.rowDisabled : ""
              }`}
            >
              <input
                type="checkbox"
                className={styles.check}
                checked={isChosen}
                disabled={isDisabled}
                onChange={() => toggle(candidate.uid)}
              />
              {candidate.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={candidate.photoURL}
                  alt=""
                  className={styles.avatar}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <InitialsChip name={candidate.displayName} uid={candidate.uid} size="sm" />
              )}
              <span className={styles.name}>
                <MemberName name={candidate.displayName} />
              </span>
              {/* SU recognition is a trust boundary, not a role, so it rides in
                  the chip's tooltip rather than as a second chip crowding the
                  row on a phone. */}
              <Chip
                size="sm"
                tone="neutral"
                className={styles.role}
                title={
                  candidate.suRecognised
                    ? "SU-recognised committee"
                    : `Role: ${candidate.role}`
                }
              >
                {candidate.role}
              </Chip>
              {isPinned && (
                <span className={styles.pinned} title="You are always on this list.">
                  you
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
