"use client";

import { useEffect, useMemo, useState } from "react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import CountedTextarea from "@/components/ui/CountedTextarea";
import Select from "@/components/ui/Select";
import Switch from "@/components/ui/Switch";
import { Field, Input } from "@/components/ui/Input";
import { useSiteNoticeState } from "@/features/maintenance/useSiteNotice";
import bannerStyles from "@/features/maintenance/SiteNoticeBanner.module.css";
import {
  SITE_NOTICE_LEVELS,
  SITE_NOTICE_LIMITS,
  SITE_NOTICE_PATH,
  SITE_NOTICE_SURFACE_FLAGS,
  SITE_NOTICE_SURFACES,
  normaliseSiteNotice,
  type SiteNoticeLevel,
  type SiteNoticeSurface,
} from "@/lib/siteNotice";
import styles from "./SiteStatusPanel.module.css";

/**
 * Admin control for the site-wide maintenance notice (publicConfig/siteNotice
 * — see src/lib/siteNotice.ts). The live section streams the same
 * useSiteNotice listener every visitor gets, so what it shows IS what the
 * site shows; edits go through /api/admin/site-notice.
 */

const LEVEL_LABELS: Record<SiteNoticeLevel, string> = {
  info: "Info — subtle, visitors can dismiss it",
  warn: "Warning — amber, not dismissible",
  critical: "Critical — red, not dismissible",
};

const SURFACE_LABELS: Record<SiteNoticeSurface, { label: string; description: string }> = {
  newRegistrations: {
    label: "Pause new member registrations",
    description:
      "Disables the final submit on /register with the notice copy inline.",
  },
  collaboratorApplications: {
    label: "Pause collaborator applications",
    description:
      "Disables the application submit on /register?type=collaborator.",
  },
  eventSignups: {
    label: "Pause event sign-ups",
    description:
      "Disables the RSVP submit on event pages. Change/cancel links from RSVP emails stay open on purpose.",
  },
};

const EXPIRY_CHOICES = [
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours (default)" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "24 hours (max)" },
];

type ServerState = {
  notice: {
    active: boolean;
    level: SiteNoticeLevel;
    message: string;
    linkUrl: string | null;
    endsAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    paused: Record<SiteNoticeSurface, boolean>;
    bannerVisible: boolean;
  };
  audit: {
    updatedByUid: string | null;
    updatedByName: string | null;
    updatedAt: string | null;
  };
};

type Draft = {
  active: boolean;
  level: SiteNoticeLevel;
  message: string;
  linkUrl: string;
  expiryMinutes: number;
  paused: Record<SiteNoticeSurface, boolean>;
};

const EMPTY_DRAFT: Draft = {
  active: false,
  level: "warn",
  message: "",
  linkUrl: "",
  expiryMinutes: 120,
  paused: {
    newRegistrations: false,
    collaboratorApplications: false,
    eventSignups: false,
  },
};

function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default function SiteStatusPanel() {
  // What every visitor's banner currently shows, live. Before the first
  // snapshot answers, say "checking" — never a premature "No notice".
  const { notice: live, connection } = useSiteNoticeState();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [audit, setAudit] = useState<ServerState["audit"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  function seedFromServer(state: ServerState) {
    setDraft({
      active: state.notice.active,
      level: state.notice.level,
      message: state.notice.message,
      linkUrl: state.notice.linkUrl ?? "",
      expiryMinutes: 120,
      paused: { ...state.notice.paused },
    });
    setAudit(state.audit);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/site-notice");
        const body = (await res.json().catch(() => null)) as
          | (ServerState & { error?: string })
          | null;
        if (cancelled) return;
        if (!res.ok || !body?.notice) {
          setLoadError(body?.error ?? "Couldn't load the current notice.");
        } else {
          seedFromServer(body);
        }
      } catch {
        if (!cancelled) setLoadError("Couldn't load the current notice.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live countdown while a notice is up.
  const expiresAtMs = live.expiresAt?.getTime() ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live.bannerVisible || expiresAtMs === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [live.bannerVisible, expiresAtMs]);

  // Exact preview: run the DRAFT through the same normaliser the site uses
  // and render with the banner's own CSS classes.
  const preview = useMemo(
    () =>
      normaliseSiteNotice(
        {
          active: draft.active,
          level: draft.level,
          message: draft.message,
          linkUrl: draft.linkUrl.trim() || null,
          [SITE_NOTICE_SURFACE_FLAGS.newRegistrations]: draft.paused.newRegistrations,
          [SITE_NOTICE_SURFACE_FLAGS.collaboratorApplications]:
            draft.paused.collaboratorApplications,
          [SITE_NOTICE_SURFACE_FLAGS.eventSignups]: draft.paused.eventSignups,
        },
        new Date(),
      ),
    [draft],
  );

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/site-notice", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | (ServerState & { ok?: boolean; error?: string })
        | null;
      if (!res.ok || !data?.ok || !data.notice) {
        setSaveError(data?.error ?? "Couldn't save the notice.");
        return;
      }
      seedFromServer(data);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2_500);
    } catch {
      setSaveError("Couldn't save the notice.");
    } finally {
      setSaving(false);
    }
  }

  function handleSave() {
    const linkUrl = draft.linkUrl.trim();
    if (linkUrl && !linkUrl.startsWith("https://")) {
      setSaveError("The link must be an https:// URL (or empty).");
      return;
    }
    void patch({
      active: draft.active,
      level: draft.level,
      message: draft.message.trim(),
      linkUrl: linkUrl || null,
      endsAt: new Date(Date.now() + draft.expiryMinutes * 60_000).toISOString(),
      [SITE_NOTICE_SURFACE_FLAGS.newRegistrations]: draft.paused.newRegistrations,
      [SITE_NOTICE_SURFACE_FLAGS.collaboratorApplications]:
        draft.paused.collaboratorApplications,
      [SITE_NOTICE_SURFACE_FLAGS.eventSignups]: draft.paused.eventSignups,
    });
  }

  function handleSwitchOff() {
    void patch({
      active: false,
      [SITE_NOTICE_SURFACE_FLAGS.newRegistrations]: false,
      [SITE_NOTICE_SURFACE_FLAGS.collaboratorApplications]: false,
      [SITE_NOTICE_SURFACE_FLAGS.eventSignups]: false,
    });
  }

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const consoleUrl = `https://console.firebase.google.com/project/${projectId}/firestore/data/~2F${SITE_NOTICE_PATH.collection}~2F${SITE_NOTICE_PATH.doc}`;
  const pausedLive = SITE_NOTICE_SURFACES.filter((s) => live.paused[s]);

  return (
    <div className={styles.stack}>
      {/* ===== Live status ===== */}
      <Card padding="lg">
        <div className={styles.liveHead}>
          <h2 className={styles.sectionTitle}>Live status</h2>
          <span
            className={`${styles.statusPill} ${
              connection !== "live"
                ? styles.statusChecking
                : live.bannerVisible
                  ? styles.statusOn
                  : styles.statusOff
            }`}
          >
            {connection === "loading"
              ? "Checking…"
              : connection === "error"
                ? "Feed unreachable"
                : live.bannerVisible
                  ? `NOTICE UP — ${live.level}`
                  : "No notice"}
          </span>
        </div>
        {connection === "loading" ? (
          <p className={styles.liveMeta}>Waiting for the live feed…</p>
        ) : connection === "error" ? (
          <p className={styles.liveMeta}>
            Can&apos;t reach the live notice feed from this browser — what
            visitors see cannot be confirmed right now. Saves below still go
            through the server.
          </p>
        ) : live.bannerVisible ? (
          <>
            <p className={styles.liveMessage}>“{live.bannerMessage}”</p>
            <p className={styles.liveMeta}>
              {pausedLive.length > 0
                ? `Paused: ${pausedLive
                    .map((s) => SURFACE_LABELS[s].label.replace(/^Pause /, ""))
                    .join(", ")}. `
                : "Banner only — nothing paused. "}
              {expiresAtMs !== null
                ? `Auto-clears in ${formatRemaining(expiresAtMs - nowMs)} (${new Date(
                    expiresAtMs,
                  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`
                : "No auto-clear time — switch it off manually."}
            </p>
          </>
        ) : (
          <p className={styles.liveMeta}>
            Visitors see nothing. This section is realtime — it streams the same
            listener every visitor&apos;s banner uses.
          </p>
        )}
        {audit?.updatedAt && (
          <p className={styles.auditLine}>
            Last changed by {audit.updatedByName ?? audit.updatedByUid ?? "unknown"} at{" "}
            {new Date(audit.updatedAt).toLocaleString()}.
          </p>
        )}
        <p className={styles.liveMeta}>
          Visitors can follow the banner&apos;s Details link to the public{" "}
          <a href="/status#log" target="_blank" rel="noopener noreferrer">
            status page
          </a>{" "}
          — availability lights plus the maintenance log (log entries are
          written on saves from this panel; break-glass console flips don&apos;t
          appear there, though the lights stay correct).
        </p>
        {connection === "live" && live.bannerVisible && (
          <div className={styles.actionsRow}>
            <Button onClick={handleSwitchOff} disabled={saving}>
              {saving ? "Working…" : "Switch everything off now"}
            </Button>
          </div>
        )}
      </Card>

      {/* ===== Compose / edit ===== */}
      <Card padding="lg">
        <h2 className={styles.sectionTitle}>Set the notice</h2>
        {!loaded ? (
          <p className={styles.liveMeta}>Loading…</p>
        ) : loadError ? (
          <p className={styles.errorText}>{loadError}</p>
        ) : (
          <div className={styles.form}>
            <Switch
              size="lg"
              checked={draft.active}
              onChange={(next) => setDraft((d) => ({ ...d, active: next }))}
              label="Show the banner"
              description="Warn without pausing anything. Pausing a surface below always shows the banner too — a pause is never silent."
            />

            <div className={styles.switchGroup}>
              {SITE_NOTICE_SURFACES.map((surface) => (
                <Switch
                  key={surface}
                  checked={draft.paused[surface]}
                  onChange={(next) =>
                    setDraft((d) => ({
                      ...d,
                      paused: { ...d.paused, [surface]: next },
                    }))
                  }
                  label={SURFACE_LABELS[surface].label}
                  description={SURFACE_LABELS[surface].description}
                />
              ))}
            </div>

            <Field id="site-notice-level" label="Severity (styling only)">
              <Select
                id="site-notice-level"
                value={draft.level}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, level: e.target.value as SiteNoticeLevel }))
                }
              >
                {SITE_NOTICE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {LEVEL_LABELS[level]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              id="site-notice-message"
              label="Message"
              hint="Plain text, shown on every page and as the error on paused forms. Left empty, a generic sentence is used."
            >
              <CountedTextarea
                id="site-notice-message"
                value={draft.message}
                max={SITE_NOTICE_LIMITS.message}
                rows={3}
                onChange={(e) => setDraft((d) => ({ ...d, message: e.target.value }))}
                placeholder="Registrations are failing to save. We're on it — back around 6pm."
              />
            </Field>

            <Field
              id="site-notice-link"
              label="More-info link (optional)"
              hint="https:// only. Rendered as a separate “More info” link."
            >
              <Input
                id="site-notice-link"
                type="url"
                value={draft.linkUrl}
                onChange={(e) => setDraft((d) => ({ ...d, linkUrl: e.target.value }))}
                placeholder="https://…"
              />
            </Field>

            <Field
              id="site-notice-expiry"
              label="Auto-clear after"
              hint="Applied from the moment you save. Banner and pauses clear together — a forgotten pause silently suppressing signups is worse than a lapsed one."
            >
              <Select
                id="site-notice-expiry"
                value={String(draft.expiryMinutes)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, expiryMinutes: Number(e.target.value) }))
                }
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.minutes} value={String(choice.minutes)}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <div className={styles.previewLabel}>Exact preview</div>
              {preview.bannerVisible ? (
                <div
                  className={`${bannerStyles.banner} ${bannerStyles[preview.level]} ${styles.previewFrame}`}
                >
                  <p className={bannerStyles.message}>{preview.bannerMessage}</p>
                  {preview.linkUrl !== null && (
                    <span className={bannerStyles.link}>More info</span>
                  )}
                </div>
              ) : (
                <p className={styles.liveMeta}>
                  Nothing on and nothing paused — visitors would see no banner.
                </p>
              )}
            </div>

            {saveError && <p className={styles.errorText}>{saveError}</p>}
            <div className={styles.actionsRow}>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : savedFlash ? "Saved ✓" : "Save & publish"}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ===== Honest limits ===== */}
      <Card padding="lg">
        <h2 className={styles.sectionTitle}>What this can and cannot do</h2>
        <ul className={styles.limitsList}>
          <li>
            Sign-in and password reset <strong>cannot be gated by this app at
            all</strong> — they go straight from the browser to Firebase. The
            banner is the entire mitigation there, and the real sign-in kill
            switch is disabling the provider in the Firebase console.
          </li>
          <li>
            Browser→Firestore writes (how member registration completes today)
            are reachable <strong>only by Firestore rules, never by a flag
            here</strong>. These switches pause the submit UI — they do not
            stop writes. Anything that genuinely must not happen during an
            incident needs a rules deploy.
          </li>
        </ul>
      </Card>

      {/* ===== Break-glass ===== */}
      <Card padding="lg">
        <h2 className={styles.sectionTitle}>Break-glass: flip it without this panel</h2>
        <p className={styles.liveMeta}>
          If the app itself is down, edit the doc directly in the{" "}
          <a href={consoleUrl} target="_blank" rel="noopener noreferrer">
            Firebase console
          </a>{" "}
          — collection <code>{SITE_NOTICE_PATH.collection}</code>, document{" "}
          <code>{SITE_NOTICE_PATH.doc}</code>. The banner updates on every open
          tab within seconds; it works even while the app server is down.
        </p>
        <ul className={styles.fieldList}>
          <li><code>active</code> (boolean) — show the banner</li>
          <li><code>level</code> (string) — <code>info</code> | <code>warn</code> | <code>critical</code></li>
          <li><code>message</code> (string) — plain text</li>
          <li><code>linkUrl</code> (string) — https:// only, else ignored</li>
          <li><code>endsAt</code> (timestamp) — auto-clear time; without it the notice clears 24h after <code>updatedAt</code></li>
          {SITE_NOTICE_SURFACES.map((surface) => (
            <li key={surface}>
              <code>{SITE_NOTICE_SURFACE_FLAGS[surface]}</code> (boolean)
            </li>
          ))}
        </ul>
        <p className={styles.liveMeta}>
          Anything missing or mistyped fails <em>open</em>: that field (or the
          whole notice) simply switches off — a malformed doc can never
          fabricate an outage or crash a page.
        </p>
      </Card>
    </div>
  );
}
