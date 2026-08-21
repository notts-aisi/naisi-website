"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupRosterPayload } from "@/app/api/courses/groups/[groupId]/roster/route";

/**
 * Who is in one group — the data behind the facilitator group page, the group
 * email composer and the run home's facilitator panel. THE only roster fetch
 * in the learning space; anything that needs these names calls this.
 *
 * A one-shot fetch with a manual refresh (the `useReviewQueue` /
 * `useRunApplications` idiom), not `onSnapshot`, for the same reason those
 * hooks give: `courseGroups` and `courseEnrolments` are read-locked to the
 * authoring tier in firestore.rules, so the roster ROUTE is the only way this
 * data reaches a facilitator at all — and it is also the thing that strips
 * everything but names off it. There is no client query that could replace it,
 * and a roster only moves when an admin re-allocates, which is not something a
 * facilitator is sitting here waiting for.
 *
 * ── PII BOUNDARY ────────────────────────────────────────────────────────────
 * The payload carries `displayName` and nothing else identifying. This hook
 * adds no lookup of its own — no users read, no uid→email map, nothing derived
 * from a uid beyond using it as a React key. Names render through `MemberName`,
 * whose fallback chain ends at "NAISI member", never at an email.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY `memberCount` IS `number | null` ────────────────────────────────────
 * Null means "we do not know yet", and the email composer treats that as a
 * BLOCK on the real send rather than as zero: the composer's whole safety
 * property is that the confirm restates how many people the message reaches,
 * and a count it cannot vouch for would turn that sentence into a guess about
 * an irreversible action. `members.length` alone cannot express the difference
 * between an empty group and an unloaded one.
 *
 * ── IDLE IS A REAL STATE ────────────────────────────────────────────────────
 * An empty `groupId` means "no group to ask about" — the run home passes it
 * when the reader facilitates nothing, and the email composer passes it on the
 * cohort lane, where the count comes from that page's server shell instead.
 * Idle fetches nothing and reports `loading: false` with a null count, so a
 * caller with no group never shows a spinner for a request that was never
 * made.
 *
 * Callers that need less than this take less: the run home reads `group` and
 * `members` and ignores the refresh and the count. That is the point of one
 * hook — the fetch, the stale-response guard and the error sentence exist
 * once, and a surface that wants more state later does not have to grow a
 * second copy of them to get it.
 */

export type RosterGroup = GroupRosterPayload["group"];
export type RosterPerson = GroupRosterPayload["members"][number];

export type GroupRosterState = {
  /** Null until a payload for THIS group has landed. */
  group: RosterGroup | null;
  /** Names only. */
  facilitators: RosterPerson[];
  /** Active members, name-sorted by the route. Names only. */
  members: RosterPerson[];
  /** Active member count, or null while it is genuinely unknown (see header). */
  memberCount: number | null;
  /** True on the first load of a group AND on a manual refresh. */
  loading: boolean;
  error: Error | null;
  reload: () => void;
};

/** Shared empty array — read-only by contract, never mutated. */
const NO_PEOPLE: RosterPerson[] = [];

/** A separator that cannot occur in a group id, so a stamp has one spelling. */
const SEP = " ";

export function useGroupRoster(groupId: string): GroupRosterState {
  const idle = !groupId;

  // Key-tagged store (the `useReviewQueue` idiom): switching group must DROP
  // the previous group's names rather than show them under a new heading, and
  // the only way to be sure of that is to carry the key the data was fetched
  // for.
  const [store, setStore] = useState<{
    key: string;
    data: GroupRosterPayload | null;
    error: Error | null;
  }>({ key: "", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  // The stamp whose fetch has landed. Deriving `loading` from the pair (rather
  // than flipping a boolean inside the effect body, which is a cascading
  // render) means a manual `reload()` reads as "refreshing" straight away.
  const [settled, setSettled] = useState("");

  const stamp = `${groupId}${SEP}${nonce}`;

  useEffect(() => {
    if (idle) return;
    let cancelled = false;
    // Same-origin default carries the session cookie; no `credentials` needed.
    fetch(`/api/courses/groups/${encodeURIComponent(groupId)}/roster`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | (GroupRosterPayload & { error?: string })
          | null;
        if (!res.ok || !body || !body.group) {
          // The route's own sentence where it gave one: a facilitator who has
          // been taken off the group needs to read "Forbidden", not "failed".
          throw new Error(body?.error ?? `Couldn't load the roster (${res.status}).`);
        }
        return body;
      })
      .then((payload) => {
        if (!cancelled) setStore({ key: groupId, data: payload, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A failed REFRESH keeps the names it already had — the surface says
        // so alongside. A failed FIRST load of this key has nothing to keep.
        setStore((prev) => ({
          key: groupId,
          data: prev.key === groupId ? prev.data : null,
          error: e instanceof Error ? e : new Error(String(e)),
        }));
      })
      .finally(() => {
        if (!cancelled) setSettled(stamp);
      });
    return () => {
      cancelled = true;
    };
  }, [idle, groupId, stamp, nonce]);

  const fresh = store.key === groupId ? store : null;
  const data = fresh?.data ?? null;

  const facilitators = useMemo(() => data?.facilitators ?? NO_PEOPLE, [data]);
  const members = useMemo(() => data?.members ?? NO_PEOPLE, [data]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    group: data?.group ?? null,
    facilitators,
    members,
    memberCount: data ? data.members.length : null,
    loading: idle ? false : settled !== stamp,
    error: fresh?.error ?? null,
    reload,
  };
}

export default useGroupRoster;
