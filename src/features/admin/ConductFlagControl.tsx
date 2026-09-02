"use client";

import { useEffect, useState } from "react";
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
 * conduct.
 */
export default function ConductFlagControl({ uid, displayName }: Props) {
  const [state, setState] = useState<FlagState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The row can be collapsed while the request is in flight, so the result
    // is dropped rather than written into an unmounted component.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/members/${encodeURIComponent(uid)}/conduct-flag`,
        );
        const body = (await res.json().catch(() => null)) as
          | (Partial<FlagState> & { error?: string })
          | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setLoadError(body?.error ?? "Could not load the conduct flag.");
          return;
        }
        setState(readFlag(body));
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError("Could not load the conduct flag.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

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

  function onFlag() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Give a reason before flagging.");
      return;
    }
    const ok = window.confirm(
      `Flag ${displayName}?\n\n`
        + "Reviewers will see that a flag exists. They will not see the reason, "
        + "and neither will the member.",
    );
    if (!ok) return;
    void save(true, trimmed);
  }

  function onClear() {
    const ok = window.confirm(
      `Remove the conduct flag on ${displayName}?\n\nThe reason is deleted with it.`,
    );
    if (!ok) return;
    void save(false, "");
  }

  const current = state ?? EMPTY;

  return (
    <div className={styles.block}>
      <span className={styles.label}>
        Conduct flag
        <span className={styles.hint}>(admins only)</span>
      </span>

      {state === null && loadError === null && <p className={styles.muted}>Checking…</p>}
      {loadError !== null && <p className={styles.error}>{loadError}</p>}

      {state !== null && current.flagged && (
        <div className={styles.flagged}>
          <span className={styles.chip}>Flagged</span>
          <MemberText text={current.reason} className={styles.reason} />
          <p className={styles.muted}>
            {current.byName ? `Set by ${current.byName}` : "Set by an admin"}
            {current.flaggedAt ? ` on ${new Date(current.flaggedAt).toLocaleDateString("en-GB")}` : ""}
          </p>
          <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
            Remove flag
          </Button>
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

      {state !== null && !current.flagged && composing && (
        <div className={styles.compose}>
          <CountedTextarea
            value={reason}
            max={CONDUCT_FLAG_FIELD_LIMITS.reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="What happened, and when"
            aria-label={`Reason for flagging ${displayName}`}
            disabled={busy}
          />
          <p className={styles.muted}>
            The reason is visible to admins only. Reviewers see a yes or no chip, and the
            member never sees any of it.
          </p>
          <div className={styles.actions}>
            <Button size="sm" variant="danger" onClick={onFlag} disabled={busy}>
              Flag
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
