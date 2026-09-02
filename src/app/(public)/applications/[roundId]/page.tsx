import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import MemberText from "@/components/ui/MemberText";
import {
  APPLICATION_STATUS_TONE,
  applicationStatusBlurb,
} from "@/features/admissions/applicationStatus";
import { answerText } from "@/lib/admissions/statusHub";
import { loadStatusRowForRound } from "@/lib/admissions/statusHubData";
import type { ApplicationStatusRow } from "@/lib/admissions/statusTypes";
import { formatRoundDate, formatRoundDeadline } from "@/lib/admissions/window";
import { formatRunStartShort } from "@/lib/courses/window";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { ADMISSION_APPLICATION_STATUS_LABEL } from "@/lib/firestore/admissionApplications";
import styles from "../applications.module.css";

/**
 * `/applications/[roundId]` - one application, read back to the person who
 * wrote it.
 *
 * Same reasoning as the list page it hangs off (`(public)` so a `pending`
 * account can reach it, protected in `src/proxy.ts` because there is nothing
 * on it for a signed-out visitor, and a server component because the two
 * collections behind it are `allow read, write: if false`).
 *
 * ## Three different kinds of nothing, and they are not the same page
 *
 *  - No round with this id: `notFound()`. There is no object to talk about.
 *  - A round, but no application: a card saying so, with a link to apply if
 *    the window is open. This is what somebody who typed the url, or who
 *    started an application on another account, should see. It is deliberately
 *    NOT a 404: the round exists and they can act on it.
 *  - An application whose round has since been archived: the row renders in
 *    full, with no link onward, because their answers are still their answers.
 *
 * ## Everything the applicant typed goes through MemberText
 *
 * Their own answers are member-authored strings and render as text nodes, with
 * no markdown, no HTML and no linkification. That is the rule for member text
 * everywhere on the site (`MemberText.tsx` states it); it holds here even
 * though the only reader is the person who typed it, because "only they can
 * see it" is a property of the session, and sessions get borrowed.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ roundId: string }> };

export const metadata: Metadata = {
  title: "Your application",
  robots: { index: false, follow: true },
};

function facts(row: ApplicationStatusRow): string[] {
  const out: string[] = [];
  const submittedAt = row.application.submittedAt
    ? new Date(row.application.submittedAt)
    : null;
  if (submittedAt && !Number.isNaN(submittedAt.getTime())) {
    out.push(`Submitted ${formatRoundDeadline(submittedAt)}`);
  }
  const withdrawnAt = row.application.withdrawnAt
    ? new Date(row.application.withdrawnAt)
    : null;
  if (withdrawnAt && !Number.isNaN(withdrawnAt.getTime())) {
    out.push(`Withdrawn ${formatRoundDeadline(withdrawnAt)}`);
  }
  if (row.round.windowState === "open" && row.round.closesAt) {
    const at = new Date(row.round.closesAt);
    if (!Number.isNaN(at.getTime())) out.push(`Applications close ${formatRoundDeadline(at)}`);
  }
  if (row.round.windowState === "not-yet" && row.round.opensAt) {
    const at = new Date(row.round.opensAt);
    if (!Number.isNaN(at.getTime())) out.push(`Applications open ${formatRoundDate(at)}`);
  }
  if (row.round.decisionsByDate) {
    const label = formatRunStartShort(row.round.decisionsByDate);
    if (label) out.push(`Decisions by ${label}`);
  }
  return out;
}

/** The chosen stream and fellowships, in the round's own words. */
function preferenceLines(row: ApplicationStatusRow): string[] {
  const section = row.round.programmePreference;
  if (!section.enabled) return [];
  const chosen = row.application.programmePreference;
  const lines: string[] = [];
  const stream = section.streams.find((option) => option.id === chosen.streamId);
  if (stream) lines.push(`Stream: ${stream.label}`);
  const ranked = chosen.rankedFellowshipIds
    .map((id) => section.fellowships.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (ranked.length > 0) lines.push(`Fellowships, in order: ${ranked.join(", ")}`);
  if (chosen.openToFellowship) {
    lines.push("Happy to be considered for a fellowship place instead");
  }
  return lines;
}

export default async function ApplicationDetailPage({ params }: Params) {
  const { roundId } = await params;
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/applications/${roundId}`)}`);
  }

  const db = getAdminDb();
  if (!db) notFound();

  const loaded = await loadStatusRowForRound(db, user.uid, roundId, new Date());
  if (loaded.roundMissing) notFound();

  const row = loaded.row;
  // A draft or archived round is not a public object, so somebody who did not
  // apply to it learns nothing from this page, not even that it exists.
  // Somebody who DID apply still reads their own row below.
  if (!row && !loaded.roundPublic) notFound();

  if (!row) {
    return (
      <section className={styles.page}>
        <div className="container">
          <Link href="/applications" className={styles.back}>
            Back to your applications
          </Link>
          <Card padding="lg" className={styles.empty}>
            <h1 className={styles.emptyTitle}>No application here</h1>
            <p className={styles.emptyBody}>
              This account has not applied to this round. If you started one on
              a different account, sign in with that one and it will be here.
            </p>
            <Link href={`/apply/${encodeURIComponent(roundId)}`} className={styles.button}>
              Read about this round
            </Link>
          </Card>
        </div>
      </section>
    );
  }

  const lines = facts(row);
  const preference = preferenceLines(row);

  return (
    <section className={styles.page}>
      <div className="container">
        <Link href="/applications" className={styles.back}>
          Back to your applications
        </Link>

        <header className={styles.hero}>
          {row.round.academicYear ? (
            <Badge tone="accent">{row.round.academicYear}</Badge>
          ) : null}
          <h1 className={styles.title}>{row.round.label}</h1>
          <Badge tone={APPLICATION_STATUS_TONE[row.application.status]}>
            {ADMISSION_APPLICATION_STATUS_LABEL[row.application.status]}
          </Badge>
          <p className={styles.lede}>
            {applicationStatusBlurb(row.application.status, row.round.windowState)}
          </p>
        </header>

        {lines.length > 0 ? (
          <ul className={styles.facts}>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        {/* The decider's note, and ONLY when they ticked "share this with the
            applicant". `buildStatusRow` is what enforces that; an unshared
            reason is an empty string by the time it reaches this page. */}
        {row.sharedDecisionReason ? (
          <Card padding="lg" className={styles.note}>
            <h2 className={styles.sectionTitle}>A note from us</h2>
            <MemberText text={row.sharedDecisionReason} />
          </Card>
        ) : null}

        {row.href ? (
          <div className={styles.rowActions}>
            <Link href={row.href} className={styles.button}>
              {row.hrefKind === "resume" ? "Carry on writing it" : "Open the form"}
            </Link>
          </div>
        ) : null}

        <h2 className={styles.sectionTitle}>What you sent</h2>
        {row.stages.map((stage) => {
          if (!stage.released) {
            const at = stage.releasesAt ? new Date(stage.releasesAt) : null;
            const when =
              at && !Number.isNaN(at.getTime())
                ? `opens ${formatRoundDeadline(at)}`
                : "opens later in the window";
            return (
              <Card key={stage.id} padding="lg" className={styles.stage}>
                <h3 className={styles.stageTitle}>{stage.label}</h3>
                <p className={styles.stageNote}>
                  This part {when}. There is nothing to read in it yet, for
                  anyone.
                </p>
              </Card>
            );
          }
          const answers = row.application.stageAnswers[stage.id] ?? {};
          const submittedAt = row.application.stageSubmittedAt[stage.id] ?? null;
          const questions = stage.questions ?? [];
          return (
            <Card key={stage.id} padding="lg" className={styles.stage}>
              <h3 className={styles.stageTitle}>{stage.label}</h3>
              <p className={styles.stageNote}>
                {submittedAt
                  ? "Sent, and locked."
                  : "Not sent yet, so you can still change it."}
              </p>
              <dl className={styles.review}>
                {questions.map((question) => {
                  const text = answerText(answers[question.id]);
                  return (
                    <div key={question.id} className={styles.reviewRow}>
                      <dt className={styles.reviewLabel}>{question.label}</dt>
                      <dd className={styles.reviewValue}>
                        {text ? (
                          <MemberText text={text} />
                        ) : (
                          <span className={styles.blank}>Not answered</span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </Card>
          );
        })}

        {preference.length > 0 ? (
          <Card padding="lg" className={styles.stage}>
            <h3 className={styles.stageTitle}>What you asked to be considered for</h3>
            <ul className={styles.facts}>
              {preference.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
