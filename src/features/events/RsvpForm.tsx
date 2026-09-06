"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { useAuth } from "@/auth/AuthProvider";
import { useHydrated } from "@/hooks/useHydrated";
import { useSiteNotice } from "@/features/maintenance/useSiteNotice";
import { SurfacePausedNotice } from "@/features/maintenance/SurfacePausedNotice";
import { isSurfacePaused } from "@/lib/siteNotice";
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
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  // The name and email boxes are UNCONTROLLED and read out of the DOM when the
  // form is submitted. The event page is server-rendered, so a guest can be
  // typing into this form before its JavaScript has landed, and controlled
  // boxes lost every one of those characters: React's first render wrote its
  // own empty state over them.
  const formRef = useRef<HTMLFormElement>(null);
  const readField = useCallback((id: string) => {
    const box = formRef.current?.querySelector<HTMLInputElement>(`#${id}`);
    return box?.value ?? "";
  }, []);
  // Disables the submit until React is listening. Before that a press ran the
  // browser's own submission instead: the page came back looking untouched,
  // with the answers gone and nothing said anywhere.
  const hydrated = useHydrated();
  const [answers, setAnswers] = useState<Record<string, RsvpAnswer>>({});
  const [joinEvents, setJoinEvents] = useState(false);
  const [joinNewsletter, setJoinNewsletter] = useState(false);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  // Maintenance notice: a paused eventSignups surface disables the submit with
  // the notice copy inline (client-side only — the RSVP route is untouched).
  // The token-gated change/cancel flows stay open on purpose: stranding
  // someone trying to free up a place helps nobody.
  const siteNotice = useSiteNotice();
  const signupsPaused = isSurfacePaused(siteNotice, "eventSignups");

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
  const sessionName = signedInIdentity ? signedInIdentity.name : null;
  const sessionEmail = signedInIdentity ? signedInIdentity.email : null;

  // A session resolves after the first paint, so a locked identity is written
  // into the boxes rather than rendered as their value: the boxes have to
  // stay uncontrolled for the guest case above.
  useEffect(() => {
    const form = formRef.current;
    if (!form || sessionEmail === null) return;
    const nameBox = form.querySelector<HTMLInputElement>("#rsvp-name");
    if (nameBox) nameBox.value = sessionName ?? "";
    const emailBox = form.querySelector<HTMLInputElement>("#rsvp-email");
    if (emailBox) emailBox.value = sessionEmail;
  }, [sessionName, sessionEmail]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The session wins where there is one, exactly as the locked boxes show;
    // otherwise whatever the guest typed, however early they typed it.
    const name = sessionEmail !== null ? (sessionName ?? "") : readField("rsvp-name");
    const email = sessionEmail !== null ? sessionEmail : readField("rsvp-email");
    if (signupsPaused) {
      // Belt and braces behind the disabled submit — never a silent block.
      setState({ kind: "error", message: siteNotice.bannerMessage });
      return;
    }
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

      // Real submissions get a dedicated confirmation page so the "we've got
      // it" message can't be missed. The preview/test flow stays in place.
      if (previewMode) {
        setState({ kind: "success" });
      } else {
        router.push(`/events/${event.id}/rsvp/submitted`);
      }
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

      {/* Addressed by the browser end-to-end suite, which fills this form as a
          signed-out guest and checks it fits a phone. */}
      <form ref={formRef} onSubmit={onSubmit} className={styles.form} data-testid="rsvp-form">
        <Field id="rsvp-name" label="Your name">
          <Input
            id="rsvp-name"
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

        {/* data-testid: when the browser end-to-end suite does not reach the
            confirmation page it reads this, so a refusal is reported as the
            sentence the guest saw rather than as a navigation timeout. */}
        {state.kind === "error" && (
          <p className={styles.danger} data-testid="rsvp-error">
            {state.message}
          </p>
        )}

        {signupsPaused && (
          <SurfacePausedNotice notice={siteNotice} surface="eventSignups" />
        )}
        <div className={styles.actions}>
          {/* `!hydrated` carries the disabled attribute into the server markup,
              so an early press or an Enter in a field does nothing at all
              rather than submitting the form the browser's own way. */}
          <Button
            type="submit"
            disabled={state.kind === "submitting" || signupsPaused || !hydrated}
            data-testid="rsvp-submit"
          >
            {state.kind === "submitting" ? "Submitting…" : "Request RSVP"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
