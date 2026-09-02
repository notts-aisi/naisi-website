/**
 * The in-form privacy notice, shown on the application itself.
 *
 * A policy page nobody reads is not a notice. This is the short version, in
 * front of the person while they are typing the answers it describes, and it
 * links to the full "Courses and programmes" section for the rest. Keep it to
 * the four things an applicant would not guess: their drafts are saved on our
 * servers, other students read the answers, the access-requirements box is
 * handled differently from everything else, and reviewer notes are theirs to
 * ask for.
 *
 * PLAIN TEXT ONLY, deliberately. Nothing here is authored in a database, so
 * there is no member-written string to render and no reason for any markup
 * beyond the two links. If a future PR wants the copy to be editable, it
 * needs a route, a schema and a MemberText render, not a change here.
 *
 * Mounted by the apply flow (PR9) on every stage of the form, not just the
 * first, since a stage is a page in its own right and an applicant can land
 * on any of them from a saved draft.
 *
 * The wording is the owner's: it must stay consistent with the "Courses and
 * programmes" section of the current privacy policy
 * (src/content/legal/privacy/v3.tsx). If one changes, change both.
 */

/** Where the full section lives. One place to fix if the anchor ever moves. */
export const COURSES_PRIVACY_HREF = "/privacy#courses";

export default function ApplicationPrivacyNotice({
  className,
}: {
  className?: string;
}) {
  return (
    <aside
      className={className}
      aria-label="How we use what you write here"
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        padding: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          color: "var(--color-text-muted)",
        }}
      >
        How we use what you write here
      </h3>
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
        }}
      >
        Your answers are saved to your NAISI account as you go, including
        drafts, so you can come back and finish later. Applications are read
        and scored by student reviewers from our committee, without your name
        attached. Reviewers write notes, and you can ask us at any time what
        was written about you.
      </p>
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
        }}
      >
        Anything you put in the access-requirements box is handled separately:
        it is stored apart from the rest of your application, it is never
        scored, reviewers never see it, and only the person making the final
        decision and site admins can open it. We record each time one of them
        does. Leaving it blank does not count against you.
      </p>
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-sm)",
          lineHeight: 1.6,
          color: "var(--color-text-muted)",
        }}
      >
        The full detail, including how long we keep applications and who can
        see what once you are on a programme, is in{" "}
        <a href={COURSES_PRIVACY_HREF} target="_blank" rel="noreferrer noopener">
          Courses and programmes
        </a>{" "}
        in our <a href="/privacy">privacy policy</a>.
      </p>
    </aside>
  );
}
