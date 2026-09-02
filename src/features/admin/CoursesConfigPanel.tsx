"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import styles from "./CoursesConfigPanel.module.css";

/**
 * The three `config/courses` knobs a human changes: the anonymous feedback
 * form offered when somebody leaves a course, the weekly feedback form the
 * attendance push links to, and how long a register may go unmarked before
 * the follow-up job raises a task against its facilitator.
 *
 * It lives on the SITE STATUS page rather than under /admin/courses on
 * purpose. Neither value is course content: they are site-wide operational
 * settings that happen to be read by the courses feature, and the audience
 * for them is whoever is asking "is the site behaving", not whoever is
 * writing week 3.
 *
 * Both fields have defaults that keep the platform working when the document
 * does not exist at all (`DEFAULT_COURSES_CONFIG`), so an empty form is a
 * complete state and the panel says which value is standing in.
 */

type ServerState = {
  dropOutFeedbackUrl: string;
  weeklyFeedbackUrl: string;
  unmarkedRegisterGraceHours: number;
  defaults: {
    dropOutFeedbackUrl: string;
    weeklyFeedbackUrl: string;
    unmarkedRegisterGraceHours: number;
  };
};

export default function CoursesConfigPanel() {
  const [defaults, setDefaults] = useState<ServerState["defaults"] | null>(null);
  const [feedbackUrl, setFeedbackUrl] = useState("");
  const [weeklyUrl, setWeeklyUrl] = useState("");
  const [graceHours, setGraceHours] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/courses-config");
        const body = (await res.json().catch(() => null)) as
          | (ServerState & { error?: string })
          | null;
        if (cancelled) return;
        if (!res.ok || !body?.defaults) {
          setLoadError(body?.error ?? "Couldn't load the course settings.");
        } else {
          setDefaults(body.defaults);
          setFeedbackUrl(body.dropOutFeedbackUrl);
          setWeeklyUrl(body.weeklyFeedbackUrl ?? "");
          setGraceHours(String(body.unmarkedRegisterGraceHours));
        }
      } catch {
        if (!cancelled) setLoadError("Couldn't load the course settings.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setSavedFlash(false);
    const hours = Number(graceHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      setSaveError("The grace period must be a number of hours above zero.");
      setSaving(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/courses-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dropOutFeedbackUrl: feedbackUrl.trim(),
          weeklyFeedbackUrl: weeklyUrl.trim(),
          unmarkedRegisterGraceHours: hours,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        dropOutFeedbackUrl?: string;
        weeklyFeedbackUrl?: string;
        unmarkedRegisterGraceHours?: number;
      } | null;
      if (!res.ok || !body?.ok) {
        setSaveError(body?.error ?? "Couldn't save the course settings.");
        return;
      }
      // Seeded from the SERVER's answer, not the draft: the reader normalises
      // what it stored, so what comes back is what the site will actually use.
      setFeedbackUrl(body.dropOutFeedbackUrl ?? "");
      setWeeklyUrl(body.weeklyFeedbackUrl ?? "");
      if (typeof body.unmarkedRegisterGraceHours === "number") {
        setGraceHours(String(body.unmarkedRegisterGraceHours));
      }
      setSavedFlash(true);
    } catch {
      setSaveError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="lg">
      <h2 className={styles.sectionTitle}>Course settings</h2>
      {!loaded ? (
        <p className={styles.meta}>Loading...</p>
      ) : loadError ? (
        <p className={styles.errorText}>{loadError}</p>
      ) : (
        <div className={styles.form}>
          <Field
            id="courses-dropout-feedback-url"
            label="Drop-out feedback form"
            hint="Shown to someone who has just left a course, and linked from their confirmation email. Leave it empty to ask for nothing, which is a complete state. Must start with http:// or https://."
          >
            <Input
              id="courses-dropout-feedback-url"
              value={feedbackUrl}
              onChange={(e) => setFeedbackUrl(e.target.value)}
              placeholder="https://forms.gle/..."
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            id="courses-weekly-feedback-url"
            label="Weekly feedback form"
            hint="Linked from the reminder each group gets when its facilitator pushes the register. Leave it empty and the email simply does not mention one. Must start with http:// or https://."
          >
            <Input
              id="courses-weekly-feedback-url"
              value={weeklyUrl}
              onChange={(e) => setWeeklyUrl(e.target.value)}
              placeholder="https://forms.gle/..."
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field
            id="courses-unmarked-grace-hours"
            label="Unmarked register grace period (hours)"
            hint={
              defaults
                ? `How long after a session ends before the follow-up task is raised against its facilitator. Long enough that an evening session marked the next morning is not chased. Default ${defaults.unmarkedRegisterGraceHours}.`
                : "How long after a session ends before the follow-up task is raised against its facilitator."
            }
          >
            <Input
              id="courses-unmarked-grace-hours"
              value={graceHours}
              onChange={(e) => setGraceHours(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>

          {saveError ? <p className={styles.errorText}>{saveError}</p> : null}

          <div className={styles.actionsRow}>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving..." : "Save course settings"}
            </Button>
            {savedFlash ? <span className={styles.meta}>Saved.</span> : null}
          </div>
        </div>
      )}
    </Card>
  );
}
