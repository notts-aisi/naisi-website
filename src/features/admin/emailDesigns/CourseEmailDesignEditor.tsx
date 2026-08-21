"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import {
  COURSE_DEFAULT_LABELS,
  COURSE_SUBJECT_MAX,
  COURSE_TEMPLATE_TRIGGER,
  courseTemplateDefaults,
  normalizeCourseTemplate,
  type CourseTemplateDoc,
  type CourseTemplateId,
} from "@/lib/firestore/courseEmails";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import EmailPreview from "@/features/newsletter/editor/EmailPreview";
import {
  courseSampleTokens,
  courseTemplateUsesGroupTokens,
  courseTemplateUsesWeekTokens,
} from "./courseEmailSamples";
import styles from "./CourseEmailDesignEditor.module.css";

/**
 * Admin editor for one `courseEmailTemplates/{id}` doc — structurally the
 * application-email editor (EmailDesignEditor.tsx) with three deliberate
 * differences:
 *
 *  1. **No seed step.** `applicationEmailTemplates` are seeded on first visit to
 *     the index page; course templates are not, because the send path is
 *     fallback-first (courseApplicationEmails.ts reads the doc, falls back to
 *     `courseTemplateDefaults` when it is missing, malformed, or empty). So a
 *     missing doc is a normal steady state — "Using defaults" — and Save is a
 *     `setDoc` create rather than an `updateDoc`.
 *  2. **No recipients modifier.** Course mail goes to the one address the
 *     applicant applied with; there is no Google/university split to choose.
 *  3. **A different token map** (courseEmails.ts `buildCourseTokens`), with the
 *     group-scoped tokens only resolving on the placement email.
 */

type Props = {
  templateId: CourseTemplateId;
};

type TestStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; addresses: string[] }
  | { kind: "error"; message: string };

type Overrides = {
  subject?: string;
  blocks?: Block[];
};

type TokenHelp = { token: string; description: string };

const ALWAYS_TOKENS: TokenHelp[] = [
  { token: "firstName", description: "First word of their name — best for greetings." },
  {
    token: "preferredName",
    description: "Their preferred name, falling back to their display name.",
  },
  { token: "courseTitle", description: "The course's title, e.g. AI Safety Fundamentals." },
  { token: "runLabel", description: "Which run this is, e.g. Autumn 2026." },
  { token: "startDate", description: "The run's first day, written out, e.g. Monday 6 October." },
];

const GROUP_TOKENS: TokenHelp[] = [
  { token: "groupName", description: "The small group they were placed in." },
  { token: "facilitatorNames", description: "Who facilitates that group, e.g. Priya and Sam." },
  { token: "firstSessionWhen", description: "Their group's first session, date and time." },
];

/**
 * The weekly nudge's own map. It does NOT resolve {startDate} or
 * {preferredName} — a different module builds its tokens
 * (`src/lib/email/courseNudgeEmail.ts`) — so the lifecycle lists above are
 * replaced rather than added to when this template is open.
 */
const WEEK_TOKENS: TokenHelp[] = [
  { token: "firstName", description: "First word of their name — best for greetings." },
  { token: "courseTitle", description: "The course's title, e.g. AI Safety Fundamentals." },
  { token: "runLabel", description: "Which run this is, e.g. Autumn 2026." },
  { token: "weekNumber", description: "The taught week the cohort is on, e.g. 3." },
  { token: "weekTitle", description: "That week's title, e.g. Goal misgeneralisation." },
  { token: "weekSummary", description: "The week's one-line summary, as written in the week editor." },
  {
    token: "weekPrep",
    description:
      "A sentence counting what is in the week — readings to do, exercises to write up, roughly how long.",
  },
  {
    token: "sessionWhen",
    description: "When this recipient's group meets that week, e.g. Tuesday 21 October, 18:00–19:30.",
  },
  {
    token: "sessionWhere",
    description: "Where that session is, e.g. Hallward Library, B12. Online groups say Online — never the meeting link.",
  },
  { token: "weekUrl", description: "Link straight to the week page in the learning space." },
];

export default function CourseEmailDesignEditor({ templateId }: Props) {
  const { user } = useAuth();
  const [stored, setStored] = useState<CourseTemplateDoc | null>(null);
  const [loading, setLoading] = useState(true);

  // Local edits layered on top of the server snapshot (or the defaults, when no
  // doc exists yet). Empty == no unsaved changes — same idiom as the
  // application-email editor, avoiding setState-in-effect on hydration.
  const [overrides, setOverrides] = useState<Overrides>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "courseEmailTemplates", templateId),
      (snap) => {
        // A missing doc is expected, not an error: the send path falls back to
        // `courseTemplateDefaults` until an admin saves something here.
        setStored(snap.exists() ? normalizeCourseTemplate(snap.id, snap.data()) : null);
        setLoading(false);
      },
      (err) => {
        console.error("[course email design] snapshot", err);
        setError(err.message);
        setLoading(false);
      },
    );
    return unsub;
  }, [templateId]);

  const defaults = courseTemplateDefaults[templateId];
  const usingDefaults = stored === null;

  const baseSubject = stored?.subject || defaults.subject;
  const baseBlocks = useMemo(
    () => (stored && stored.blocks.length > 0 ? stored.blocks : cloneBlocks(defaults.blocks)),
    [stored, defaults.blocks],
  );

  const subject = overrides.subject ?? baseSubject;
  const blocks = overrides.blocks ?? baseBlocks;

  const setSubject = (v: string) => setOverrides((o) => ({ ...o, subject: v }));
  const setBlocksOverride = (v: Block[]) => setOverrides((o) => ({ ...o, blocks: v }));

  const dirty = useMemo(() => {
    if (overrides.subject !== undefined && overrides.subject !== baseSubject) return true;
    if (
      overrides.blocks !== undefined &&
      JSON.stringify(overrides.blocks) !== JSON.stringify(baseBlocks)
    ) {
      return true;
    }
    return false;
  }, [overrides, baseSubject, baseBlocks]);

  // Stable object identity so EmailPreview's effect doesn't refetch on every
  // keystroke-driven re-render. `templateId` travels with the tokens because the
  // preview endpoint renders the weekly nudge through a different component and
  // a different token pass than the five lifecycle templates — see
  // `/api/admin/course-emails/preview`.
  const previewPayload = useMemo(
    () => ({ templateId, tokens: courseSampleTokens(templateId, "Alex Taylor") }),
    [templateId],
  );

  async function handleSave() {
    if (!user) return;
    const trimmed = subject.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const db = getClientDb();
      // setDoc, not updateDoc: the doc may not exist yet (no seed step). The
      // rules allow an admin write with a non-empty subject and ≤40 blocks.
      await setDoc(doc(db, "courseEmailTemplates", templateId), {
        templateId,
        trigger: COURSE_TEMPLATE_TRIGGER[templateId],
        label: stored?.label ?? COURSE_DEFAULT_LABELS[templateId],
        subject: trimmed,
        blocks,
        // A full overwrite would otherwise silently drop a fromName set
        // elsewhere; the editor has no UI for it.
        ...(stored?.fromName ? { fromName: stored.fromName } : {}),
        updatedAt: serverTimestamp(),
        updatedBy: user.uid,
      });
      setOverrides({});
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function handleRevert() {
    setOverrides({});
    setError(null);
  }

  function handleResetToDefault() {
    const ok = window.confirm(
      "Replace the subject and body with NAISI's default copy? Nothing is saved until you press Save, so you can still back out.",
    );
    if (!ok) return;
    setOverrides({ subject: defaults.subject, blocks: cloneBlocks(defaults.blocks) });
    setError(null);
  }

  async function handleSendTest() {
    if (dirty) return;
    setTestStatus({ kind: "sending" });
    try {
      const res = await fetch(`/api/admin/course-emails/${templateId}/send-test`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Send failed (${res.status})`);
      }
      const body = (await res.json()) as { sentTo: string[] };
      setTestStatus({ kind: "sent", addresses: body.sentTo });
    } catch (err) {
      setTestStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Send failed",
      });
    }
  }

  if (loading) {
    return <p style={{ color: "var(--color-text-muted)" }}>Loading template…</p>;
  }

  const subjectOver = subject.length > COURSE_SUBJECT_MAX;
  const subjectEmpty = subject.trim().length === 0;
  const showsGroupTokens = courseTemplateUsesGroupTokens(templateId);
  const showsWeekTokens = courseTemplateUsesWeekTokens(templateId);

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{COURSE_DEFAULT_LABELS[templateId]}</h2>
          <p className={styles.subtitle}>
            {usingDefaults
              ? "No saved copy yet — this is NAISI's default wording, and it is what sends today. Saving takes over."
              : "Saved copy. This is what sends."}
          </p>
        </div>
        {dirty ? (
          <Badge tone="warning">Unsaved changes</Badge>
        ) : usingDefaults ? (
          <Badge tone="neutral">Using defaults</Badge>
        ) : (
          <Badge tone="neutral">Saved</Badge>
        )}
      </header>

      <section className={styles.tokens} aria-label="Available tokens">
        <p className={styles.tokensLead}>
          Tokens you can use in the subject and body — each is replaced at send time:
        </p>
        <dl className={styles.tokenList}>
          {(showsWeekTokens ? WEEK_TOKENS : ALWAYS_TOKENS).map((t) => (
            <div key={t.token} className={styles.tokenRow}>
              <dt>
                <code>{`{${t.token}}`}</code>
              </dt>
              <dd>{t.description}</dd>
            </div>
          ))}
          {!showsWeekTokens &&
            GROUP_TOKENS.map((t) => (
              <div
                key={t.token}
                className={`${styles.tokenRow} ${showsGroupTokens ? "" : styles.tokenRowUnavailable}`}
              >
                <dt>
                  <code>{`{${t.token}}`}</code>
                </dt>
                <dd>{t.description}</dd>
              </div>
            ))}
        </dl>
        {!showsWeekTokens && !showsGroupTokens && (
          <p className={styles.tokensNote}>
            The last three only resolve on the group placement email — nobody has a group
            yet when this one sends. Used here they arrive as the literal{" "}
            <code>{"{groupName}"}</code> text, which the preview shows you.
          </p>
        )}
        {showsWeekTokens && (
          <p className={styles.tokensNote}>
            This email behaves differently from the other five, in one way worth knowing:
            when a token has nothing to resolve to — a week with no summary written yet, a
            member whose group has no time set — the whole sentence around it is removed
            rather than left with a gap in it. So keep one of these tokens per paragraph,
            in plain text rather than inside bold or a link, and the email simply gets
            shorter instead of reading oddly. The subject line is the one thing that
            cannot be deleted, so a stranded &ldquo;:&rdquo; or &ldquo;·&rdquo; is tidied
            away there instead. The preview below fills everything in, so it shows the
            longest version a recipient could get.
          </p>
        )}
      </section>

      <div className={styles.grid}>
        <div className={styles.column}>
          <Field
            id="course-email-subject"
            label="Subject"
            hint={`${subject.length}/${COURSE_SUBJECT_MAX} characters`}
            error={
              subjectOver
                ? "Subject is too long."
                : subjectEmpty
                  ? "A subject is required."
                  : undefined
            }
          >
            <Input
              id="course-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={COURSE_SUBJECT_MAX + 20}
              placeholder={
                showsWeekTokens
                  ? "{weekTitle} · Week {weekNumber} of {courseTitle}"
                  : "You're in — {courseTitle} starts {startDate}"
              }
            />
          </Field>

          {/* Image uploads land under the admin-only `application-emails/…`
              Storage namespace with a `course-` prefixed folder. storage.rules
              has no `course-emails/` block and adding one is a rules change,
              which is out of scope for this PR (2026-08-21); the existing block
              is `match /application-emails/{templateId}/{image=**}` with
              admin-only write + public read, which is exactly the trust model a
              course email needs (inboxes fetch the image unauthenticated). If a
              dedicated namespace is wanted later it is a storage.rules addition
              plus a change to this one prefix. */}
          <BlockEditor
            draftId={templateId}
            storagePrefix={`application-emails/course-${templateId}`}
            blocks={blocks}
            onChange={setBlocksOverride}
            disabled={busy}
          />

          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={busy || !dirty || subjectOver || subjectEmpty}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={handleRevert} disabled={busy || !dirty}>
              Revert
            </Button>
            <Button variant="ghost" onClick={handleResetToDefault} disabled={busy}>
              Reset to default
            </Button>
            <Button
              variant="secondary"
              onClick={handleSendTest}
              disabled={dirty || testStatus.kind === "sending"}
            >
              {testStatus.kind === "sending" ? "Sending test…" : "Send test to me"}
            </Button>
            {savedFlash && (
              <span className={`${styles.statusLine} ${styles.statusSuccess}`}>Saved.</span>
            )}
            {dirty && (
              <span className={styles.statusLine}>Save your changes to send a test.</span>
            )}
            {!dirty && usingDefaults && (
              <span className={styles.statusLine}>
                A test send uses the default copy, same as a real send would.
              </span>
            )}
            {error && (
              <span className={`${styles.statusLine} ${styles.statusError}`}>{error}</span>
            )}
            {testStatus.kind === "sent" && testStatus.addresses.length > 0 && (
              <span className={`${styles.statusLine} ${styles.statusSuccess}`}>
                Test sent to {testStatus.addresses.join(", ")}.
              </span>
            )}
            {testStatus.kind === "sent" && testStatus.addresses.length === 0 && (
              <span className={`${styles.statusLine} ${styles.statusError}`}>
                Test reported as sent but no addresses came back — check server logs.
              </span>
            )}
            {testStatus.kind === "error" && (
              <span className={`${styles.statusLine} ${styles.statusError}`}>
                {testStatus.message}
              </span>
            )}
          </div>
        </div>

        {/* The five lifecycle templates render through the same
            ApplicationEmail component as the membership-application mail, so
            for those this endpoint is the application-email preview verbatim.
            The weekly nudge is not: different chrome (it carries an unsubscribe
            footer) and a different token pass (unresolved tokens delete their
            sentence rather than staying literal). Previewing it through the
            generic endpoint showed an admin a message no recipient could
            receive, so the course preview route branches on templateId. */}
        <EmailPreview
          subject={subject || "(no subject)"}
          blocks={blocks}
          endpoint="/api/admin/course-emails/preview"
          extraPayload={previewPayload}
          hint={
            showsWeekTokens
              ? "This is what a recipient sees, with sample course details filled in — including the unsubscribe footer every nudge carries. Every sample below resolves, so this is the LONGEST version anyone gets: a week with no summary, or a member whose group has no time set, receives a shorter email with those sentences removed. A token this email cannot resolve (a typo, or one borrowed from another template) stays visible as {token}."
              : "This is what a recipient sees, with sample course details filled in. Tokens that don't resolve on this email stay visible as {token} — that's what would land in the inbox."
          }
        />
      </div>
    </div>
  );
}

/**
 * Defaults live in a module-level constant shared across every mount, so hand a
 * copy to the editor: BlockEditor's array updates are immutable but a future
 * consumer's need not be, and one mutated default would poison every reset for
 * the life of the tab.
 */
function cloneBlocks(blocks: Block[]): Block[] {
  return blocks.map((b) => ({ ...b }));
}
