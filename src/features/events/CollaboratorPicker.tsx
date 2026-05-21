"use client";

import { useEffect, useMemo, useState } from "react";

type Candidate = { uid: string; displayName: string; role: string };

type Props = {
  /** The event whose collaborator list this picker manages. */
  eventId: string;
};

/**
 * "Who can edit this" control, shown to the event's author and to admins.
 * Lists committee members and lets them be granted edit access to this one
 * event. Reads and writes through /api/events/[id]/collaborators, so it works
 * even for an author who cannot read the `users` collection directly. Each
 * change saves immediately.
 */
export default function CollaboratorPicker({ eventId }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/collaborators`);
        if (!res.ok) throw new Error(`Couldn't load collaborators (${res.status})`);
        const body = (await res.json()) as {
          candidates?: Candidate[];
          collaboratorUids?: string[];
        };
        if (cancelled) return;
        setCandidates(body.candidates ?? []);
        setSelected(body.collaboratorUids ?? []);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Couldn't load collaborators",
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  async function save(next: string[]) {
    const previous = selected;
    setSelected(next); // optimistic
    setBusy(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/collaborators`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ collaboratorUids: next }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; collaboratorUids?: string[]; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setSelected(previous); // rollback
        setSaveError(body?.error ?? `Save failed (${res.status})`);
        return;
      }
      setSelected(body.collaboratorUids ?? next);
    } catch (err) {
      setSelected(previous);
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function toggle(uid: string) {
    if (busy) return;
    save(
      selected.includes(uid)
        ? selected.filter((u) => u !== uid)
        : [...selected, uid],
    );
  }

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selected.includes(c.uid)),
    [candidates, selected],
  );

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return candidates
      .filter((c) => !term || c.displayName.toLowerCase().includes(term))
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [candidates, search]);

  if (loading) {
    return <p style={hintStyle}>Loading committee members…</p>;
  }
  if (loadError) {
    return <p style={errorStyle}>{loadError}</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {selectedCandidates.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {selectedCandidates.map((c) => (
            <button
              key={c.uid}
              type="button"
              onClick={() => toggle(c.uid)}
              disabled={busy}
              style={chipStyle}
            >
              <span>{c.displayName}</span>
              <span aria-hidden>✕</span>
            </button>
          ))}
        </div>
      ) : (
        <p style={hintStyle}>
          No collaborators yet. Only you and approvers can edit this event.
        </p>
      )}

      {candidates.length === 0 ? (
        <p style={hintStyle}>
          There are no other committee members to add yet.
        </p>
      ) : (
        <>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search committee members…"
            style={inputStyle}
          />
          <div style={listStyle}>
            {matches.length === 0 && <p style={hintStyle}>No matches.</p>}
            {matches.map((c) => {
              const isSelected = selected.includes(c.uid);
              return (
                <label key={c.uid} style={rowStyle(isSelected)}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(c.uid)}
                    disabled={busy}
                  />
                  <span>{c.displayName}</span>
                  <span style={roleStyle}>{c.role}</span>
                </label>
              );
            })}
          </div>
        </>
      )}

      {saveError && <p style={errorStyle}>{saveError}</p>}
    </div>
  );
}

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-text-muted)",
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-danger)",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "0.25rem 0.6rem",
  borderRadius: "var(--radius-pill)",
  background: "var(--color-accent-soft)",
  color: "var(--color-accent)",
  fontSize: "var(--text-xs)",
  border: "none",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.75rem",
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  color: "var(--color-text)",
  fontSize: "var(--text-sm)",
};

const listStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-elevated)",
  maxHeight: "12rem",
  overflowY: "auto",
};

function rowStyle(isSelected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "0.45rem 0.75rem",
    fontSize: "var(--text-sm)",
    cursor: "pointer",
    background: isSelected ? "var(--color-surface-hover)" : "transparent",
  };
}

const roleStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: "var(--text-xs)",
  color: "var(--color-text-subtle)",
  textTransform: "capitalize",
};
