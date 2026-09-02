import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import {
  APPLICATION_STATUS_TONE,
  applicationStatusBlurb,
} from "@/features/admissions/applicationStatus";
import { loadStatusRows } from "@/lib/admissions/statusHubData";
import type { ApplicationStatusRow } from "@/lib/admissions/statusTypes";
import { formatRoundDate, formatRoundDeadline } from "@/lib/admissions/window";
import { formatRunStartShort } from "@/lib/courses/window";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { ADMISSION_APPLICATION_STATUS_LABEL } from "@/lib/firestore/admissionApplications";
import styles from "./applications.module.css";

/**
 * `/applications` - where somebody who has applied comes back to find out
 * what happened.
 *
 * ## Why it lives in `(public)` and not `(app)`
 *
 * Exactly the reason `/apply/[roundId]` does: applying is open to any signed-in
 * account INCLUDING role `pending`, and `(app)/layout.tsx` sends a pending
 * account to `/pending-approval`. The people most likely to open this page are
 * the ones who made an account at the fair a fortnight ago and are still
 * waiting on committee approval, so putting it behind that layout would lock
 * out its whole audience.
 *
 * It IS in `src/proxy.ts`'s protected prefixes, unlike the apply page, and the
 * difference is what the two pages are for. The apply page is discovery: a
 * signed-out visitor should read what the round is and see a sign-in card.
 * This page is nothing but per-account state, so a signed-out visitor has
 * nothing to read, and the honest answer is the sign-in screen with a return
 * address. A `pending` account HAS a session cookie, so the proxy check does
 * not exclude them.
 *
 * ## A server component on the Admin SDK
 *
 * `admissionApplications` and `admissionRounds` are both
 * `allow read, write: if false`, so there is no client read to fall back on
 * and no listener to hang a spinner off. That is also what makes the empty
 * state honest: `useMyApplication` in the V2 courses code had to treat a
 * permission-denied and a not-applied-yet as the same unreadable thing,
 * because an own-row read of a MISSING document evaluates the rule against
 * null and denies. Here, no row means no row.
 *
 * ## Not filtered on the window
 *
 * Every row the caller has, open round or long closed. This is the surface
 * that has to survive the deadline; see `statusHubData.ts`.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your applications",
  description: "Where your NAISI applications have got to.",
  // Per-account state. Nothing here is any use in a search result.
  robots: { index: false, follow: true },
};

/** "Submitted Sun 18 Oct, 23:59", when there is a submission to date. */
function submittedLine(row: ApplicationStatusRow): string | null {
  const at = row.application.submittedAt;
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return `Submitted ${formatRoundDeadline(date)}`;
}

/** What the applicant has to do next, or what they are waiting on. */
function nextStageLine(row: ApplicationStatusRow): string | null {
  const next = row.nextStage;
  if (!next) return null;
  if (next.released) return `${next.label} is open now`;
  if (!next.releasesAt) return `${next.label} opens later in the window`;
  const at = new Date(next.releasesAt);
  if (Number.isNaN(at.getTime())) return `${next.label} opens later in the window`;
  return `${next.label} opens ${formatRoundDeadline(at)}`;
}

function decisionsLine(row: ApplicationStatusRow): string | null {
  const key = row.round.decisionsByDate;
  if (!key) return null;
  const label = formatRunStartShort(key);
  return label ? `Decisions by ${label}` : null;
}

function closesLine(row: ApplicationStatusRow): string | null {
  if (row.round.windowState !== "open" || !row.round.closesAt) return null;
  const at = new Date(row.round.closesAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Closes ${formatRoundDeadline(at)}`;
}

function opensLine(row: ApplicationStatusRow): string | null {
  if (row.round.windowState !== "not-yet" || !row.round.opensAt) return null;
  const at = new Date(row.round.opensAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Opens ${formatRoundDate(at)}`;
}

/** What the page says when it cannot read, which is not what it says when there is nothing to read. */
function Unavailable() {
  return (
    <section className={styles.page}>
      <div className="container">
        <header className={styles.hero}>
          <h1 className={styles.title}>Your applications</h1>
        </header>
        <Card padding="lg" className={styles.empty}>
          <h2 className={styles.emptyTitle}>We cannot read your applications right now</h2>
          <p className={styles.emptyBody}>
            This is a fault at our end, not anything you have done, and nothing
            you have sent us has been affected. Try again in a few minutes; if
            it keeps happening, reply to any email from us.
          </p>
        </Card>
      </div>
    </section>
  );
}

export default async function ApplicationsPage() {
  const user = await getCurrentUser();
  // The proxy already redirects a caller with no session cookie. This is the
  // second half of the two-layer gate: a cookie that no longer verifies gets
  // the same answer the proxy would have given, rather than an empty page.
  if (!user) redirect("/login?next=%2Fapplications");

  const db = getAdminDb();
  // NOT the empty state. An unconfigured Admin SDK means this page cannot read
  // anything, and "you have not applied to anything" is the one sentence it
  // must never say in that case: somebody who applied last week would read it
  // as the site having lost their application. Denied and absent are different
  // answers, which is the whole reason this surface is server-side.
  if (!db) return <Unavailable />;

  const rows = await loadStatusRows(db, user.uid, new Date());

  return (
    <section className={styles.page}>
      <div className="container">
        <header className={styles.hero}>
          <h1 className={styles.title}>Your applications</h1>
          <p className={styles.lede}>
            Everything you have applied to, and where each one has got to. This
            page stays here after the deadline passes.
          </p>
        </header>

        {rows.length === 0 ? (
          <Card padding="lg" className={styles.empty}>
            <h2 className={styles.emptyTitle}>Nothing here yet</h2>
            <p className={styles.emptyBody}>
              You have not applied to anything on this site. When you do, the
              application shows up here, along with the date we have promised a
              decision by.
            </p>
            <Link href="/courses" className={styles.button}>
              See what is running
            </Link>
          </Card>
        ) : (
          <ul className={styles.list}>
            {rows.map((row) => {
              const facts = [
                submittedLine(row),
                nextStageLine(row),
                closesLine(row),
                opensLine(row),
                decisionsLine(row),
              ].filter((line): line is string => Boolean(line));
              return (
                <li key={row.application.id}>
                  <Card padding="lg" className={styles.row}>
                    <div className={styles.rowHead}>
                      <div>
                        <h2 className={styles.rowTitle}>{row.round.label}</h2>
                        {row.round.academicYear ? (
                          <p className={styles.rowYear}>{row.round.academicYear}</p>
                        ) : null}
                      </div>
                      <Badge tone={APPLICATION_STATUS_TONE[row.application.status]}>
                        {ADMISSION_APPLICATION_STATUS_LABEL[row.application.status]}
                      </Badge>
                    </div>

                    <p className={styles.rowBlurb}>
                      {applicationStatusBlurb(
                        row.application.status,
                        row.round.windowState,
                      )}
                    </p>

                    {facts.length > 0 ? (
                      <ul className={styles.facts}>
                        {facts.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}

                    <div className={styles.rowActions}>
                      <Link
                        href={`/applications/${encodeURIComponent(row.round.id)}`}
                        className={styles.button}
                      >
                        Open
                      </Link>
                      {row.href && row.hrefKind === "resume" ? (
                        <Link href={row.href} className={styles.secondary}>
                          Carry on writing it
                        </Link>
                      ) : null}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
