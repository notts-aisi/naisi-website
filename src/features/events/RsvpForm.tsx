"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import {
  EMAIL_MAX,
  NAME_MAX,
  type EventDoc,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";
import FormRenderer from "./FormRenderer";
import styles from "./RsvpForm.module.css";

type Props = {
  event: EventDoc;
  /** When true, renders a banner indicating test mode (still saves real RSVPs). */
  previewMode?: boolean;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export default function RsvpForm({ event, previewMode }: Props) {
  const { user, loading: authLoading } = useAuth();
  const [anonName, setAnonName] = useState("");
  const [anonEmail, setAnonEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, RsvpAnswer>>({});
  const [joinEvents, setJoinEvents] = useState(false);
  const [joinNewsletter, setJoinNewsletter] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const questions: FormQuestion[] = event.signupForm;
  const needsLogin = event.visibility === "members" && !user && !authLoading;
  const confirmedCount = event.rsvpCountConfirmed ?? 0;
  const full = event.capacity !== null && confirmedCount >= event.capacity;

  // Signed-in users have their identity locked to the session. Anonymous users
  // type their own name + email (public events only). If the session is missing
  // displayName/email for some reason we fall through to editable inputs so the
  // form isn't bricked.
  const signedInIdentity =
    user && user.email ? { name: user.displayName ?? "", email: user.email } : null;
  const name = signedInIdentity ? signedInIdentity.name : anonName;
  const email = signedInIdentity ? signedInIdentity.email : anonEmail;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "submitting" });
    try {
      const res = await fetch(`/api/events/${event.id}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, answers }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; status?: "pending"; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setState({
          kind: "error",
          message: body?.error ?? `Signup failed (${res.status})`,
        });
        return;
      }

      // RSVP saved. Fire-and-forget the optional mailing-list opt-in — it must
      // never block the RSVP or surface its own errors to the attendee.
      const channels: string[] = [];
      if (joinEvents) channels.push("events");
      if (joinNewsletter) channels.push("newsletter");
      if (channels.length > 0) {
        void fetch("/api/subscriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, channels, source: "event-rsvp", name }),
        }).catch(() => {});
      }

      setState({ kind: "success" });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Signup failed",
      });
    }
  }

  if (needsLogin) {
    return (
      <Card padding="lg">
        <h2 className={styles.h2}>Members-only event</h2>
        <p className={styles.hint}>
          This event is for signed-in NAISI members. Sign in to RSVP.
        </p>
        <a href={`/login?redirect=/events/${event.id}`}>
          <Button>Sign in</Button>
        </a>
      </Card>
    );
  }

  if (state.kind === "success") {
    return (
      <Card padding="lg">
        <h2 className={styles.h2}>Request submitted.</h2>
        <p className={styles.hint}>
          A NAISI organiser will review your RSVP and confirm your spot. We&apos;ll be
          in touch if there&apos;s anything else we need from you.
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <h2 className={styles.h2}>RSVP</h2>
      {previewMode && (
        <p className={styles.warn}>
          Test mode — submissions here are saved to Firestore. Use them to verify
          the flow, then cancel from the attendee dashboard or Firestore console.
        </p>
      )}
      <p className={styles.hint}>
        RSVPs are reviewed by a NAISI organiser before being confirmed — this lets us
        manage catering and numbers. You&apos;ll hear back once it&apos;s approved.
      </p>
      {full && (
        <p className={styles.warn}>
          We&apos;ve hit capacity. You can still submit — approved RSVPs past capacity
          go on the waitlist if one is open.
        </p>
      )}

      {signedInIdentity && (
        <p className={styles.signedIn}>
          Signing up as <strong>{signedInIdentity.name || signedInIdentity.email}</strong>{" "}
          ({signedInIdentity.email}). Sign out to RSVP with a different account.
        </p>
      )}

      <form onSubmit={onSubmit} className={styles.form}>
        <Field id="rsvp-name" label="Your name">
          <Input
            id="rsvp-name"
            value={name}
            onChange={(e) => {
              if (!signedInIdentity) setAnonName(e.target.value);
            }}
            maxLength={NAME_MAX}
            disabled={state.kind === "submitting"}
            readOnly={!!signedInIdentity}
            required
            autoComplete="name"
          />
        </Field>
        <Field id="rsvp-email" label="Email" hint="We'll send your confirmation here.">
          <Input
            id="rsvp-email"
            type="email"
            value={email}
            onChange={(e) => {
              if (!signedInIdentity) setAnonEmail(e.target.value);
            }}
            maxLength={EMAIL_MAX}
            disabled={state.kind === "submitting"}
            readOnly={!!signedInIdentity}
            required
            autoComplete="email"
          />
        </Field>

        {questions.length > 0 && (
          <FormRenderer
            questions={questions}
            answers={answers}
            onChange={setAnswers}
            disabled={state.kind === "submitting"}
          />
        )}

        <fieldset className={styles.channels} disabled={state.kind === "submitting"}>
          <legend className={styles.channelsLegend}>Stay in the loop (optional)</legend>
          <label className={styles.channelLabel}>
            <input
              type="checkbox"
              className={styles.channelCheckbox}
              checked={joinEvents}
              onChange={(e) => setJoinEvents(e.target.checked)}
            />
            <span className={styles.channelText}>
              <span className={styles.channelName}>Email me about future events</span>
              <span className={styles.channelDescription}>
                Get an email when we announce a new event.
              </span>
            </span>
          </label>
          <label className={styles.channelLabel}>
            <input
              type="checkbox"
              className={styles.channelCheckbox}
              checked={joinNewsletter}
              onChange={(e) => setJoinNewsletter(e.target.checked)}
            />
            <span className={styles.channelText}>
              <span className={styles.channelName}>NAISI newsletter</span>
              <span className={styles.channelDescription}>
                Occasional society updates and what we&apos;re working on.
              </span>
            </span>
          </label>
        </fieldset>

        {state.kind === "error" && <p className={styles.danger}>{state.message}</p>}

        <div className={styles.actions}>
          <Button type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Submitting…" : "Request RSVP"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
