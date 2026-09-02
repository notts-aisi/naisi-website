"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import MemberText from "@/components/ui/MemberText";
import { CONDUCT_FLAG_FIELD_LIMITS } from "@/lib/firestore/memberConductFlags";
import styles from "./ConductFlagControl.module.css";

type Props = {
  uid: string;
  displayName: string;
};

type FlagState = {
  flagged: boolean;
  reason: string;
  flaggedAt: string | null;
  byName: string;
};

const EMPTY: FlagState = { flagged: false, reason: "", flaggedAt: null, byName: "" };

/** The route's payload, read defensively: this is the one place the shape of
 *  the admin projection meets the browser. */
function readFlag(body: Partial<FlagState>): FlagState {
  return {
    flagged: body.flagged === true,
    reason: typeof body.reason === "string" ? body.reason : "",
    flaggedAt: typeof body.flaggedAt === "string" ? body.flaggedAt : null,
    byName: typeof body.byName === "string" ? body.byName : "",
  };
}

/**
 * The conduct flag on the admin Members row.
 *
 * `memberConductFlags/{uid}` is unreadable and unwritable from any client, so
 * this control is a pair of calls to `/api/admin/members/[uid]/conduct-flag`
 * rather than a Firestore listener like the rest of the row. That is the whole
 * reason the collection exists: the reason text is a free-text allegation about
 * a named student, and the person it describes must never be able to reach it
 * from their own browser.
 *
 * The fetch happens on mount, and the component only mounts inside the expanded
 * panel, so opening the Members list does not ask the server about everybody's
 * conduct. MemberItem does not render this control on the admin's own row; the
 * route refuses a self-flag as well, so the rule holds against a hand-made
 * request too.
 */
export default function ConductFlagControl({ uid, displayName }: Props) {
  const [state, setState] = useState<FlagState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const res = await fetch(
          `/api/admin/members/${encodeURIComponent(uid)}/conduct-flag`,
        );
        const body = (await res.json().catch(() => null)) as
          | (Partial<FlagState> & { error?: string })
          | null;
        if (isCancelled()) return;
        if (!res.ok || !body) {
          setLoadError(body?.error ?? "Could not load the conduct flag.");
          return;
        }
        setState(readFlag(body));
        setLoadError(null);
      } catch {
        if (!isCancelled()) setLoadError("Could not load the conduct flag.");
      }
    },
    [uid],
  );

  useEffect(() => {
    // The row can be collapsed while the request is in flight, so the result
    // is dropped rather than written into an unmounted component.
    let cancelled = false;
    void (async () => {
      await load(() => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function onRetry() {
    // A failed GET would otherwise be a dead end: no state means no buttons,
    // and the only way back was to collapse the row and expand it again.
    setLoadError(null);
    void load(() => false);
  }

  async function save(flagged: boolean, withReason: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${encodeURIComponent(uid)}/conduct-flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flagged ? { flagged, reason: withReason } : { flagged }),
      });
      const body = (await res.json().catch(() => null)) as
        | (Partial<FlagState> & { error?: string })
        | null;
      if (!res.ok || !body) {
        throw new Error(body?.error ?? "Could not save the conduct flag.");
      }
      setState(readFlag(body));
      setComposing(false);
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the conduct flag.");
    } finally {
      setBusy(false);
    }
  }

  const current = state ?? EMPTY;
  /** Editing the wording of a live flag, rather than raising a new one. The
   *  route keeps the original date and author in that case, so this is a
   *  correction and not a re-flag. */
  const editing = composing && current.flagged;

  function onSubmit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(editing ? "Give a reason, or remove the flag." : "Give a reason before flagging.");
      return;
    }
    if (!editing) {
      const ok = window.confirm(
        `Flag ${displayName}?\n\n`
          + "Reviewers will see that a flag exists. They will not see the reason, "
          + "and neither will the member.",
      );
      if (!ok) return;
    }
    void save(true, trimmed);
  }

  function onEdit() {
    setReason(current.reason);
    setError(null);
    setComposing(true);
  }

  function onClear() {
    const ok = window.confirm(
      `Remove the conduct flag on ${displayName}?\n\nThe reason is deleted with it.`,
    );
    if (!ok) return;
    void save(false, "");
  }

  return (
    <div className={styles.block}>
      <span className={styles.label}>
        Conduct flag
        <span className={styles.hint}>(admins only)</span>
      </span>

      {/* Under the label in every state, not only while an admin is typing:
          somebody reading an existing flag is deciding whether to leave it
          standing, and needs to know who it is about to be shown to. */}
      <p className={styles.muted}>
        The reason is visible to admins only. Reviewers see a yes or no chip, and the
        member never sees any of it.
      </p>

      {state === null && loadError === null && <p className={styles.muted}>Checking…</p>}

      {loadError !== null && (
        <div className={styles.actions}>
          <p className={styles.error}>{loadError}</p>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      {state !== null && current.flagged && (
        <div className={styles.flagged}>
          <span className={styles.chip}>Flagged</span>
          <MemberText text={current.reason} className={styles.reason} />
          <p className={styles.muted}>
            {current.byName ? `Set by ${current.byName}` : "Set by an admin"}
            {current.flaggedAt ? ` on ${new Date(current.flaggedAt).toLocaleDateString("en-GB")}` : ""}
          </p>
          {!composing && (
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>
                Edit reason
              </Button>
              <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
                Remove flag
              </Button>
            </div>
          )}
        </div>
      )}

      {state !== null && !current.flagged && !composing && (
        <>
          <p className={styles.muted}>No flag on this member.</p>
          <Button size="sm" variant="ghost" onClick={() => setComposing(true)} disabled={busy}>
            Flag this member
          </Button>
        </>
      )}

      {state !== null && composing && (
        <div className={styles.compose}>
          <CountedTextarea
            value={reason}
            max={CONDUCT_FLAG_FIELD_LIMITS.reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What happened, and when"
            aria-label={
              editing
                ? `Reason for the conduct flag on ${displayName}`
                : `Reason for flagging ${displayName}`
            }
            disabled={busy}
          />
          {editing && (
            <p className={styles.muted}>
              Saving a new wording keeps the original date and the admin who set the flag.
            </p>
          )}
          <div className={styles.actions}>
            <Button size="sm" variant="danger" onClick={onSubmit} disabled={busy}>
              {editing ? "Save reason" : "Flag"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setComposing(false);
                setReason("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error !== null && <p className={styles.error}>{error}</p>}
    </div>
  );
}
