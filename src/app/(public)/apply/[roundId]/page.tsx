import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
} from "@/lib/admissions/roundRoutes";
import {
  serialiseApplicationForOwner,
  serialiseRoundForApplicant,
  serialiseStageForApplicant,
  type ApplicantApplication,
  type ApplicantRound,
  type ApplicantStage,
} from "@/lib/admissions/applyRoutes";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
} from "@/lib/firestore/admissionRounds";
import {
  admissionApplicationId,
  admissionApplicationPrivateId,
  normalizeAdmissionApplication,
} from "@/lib/firestore/admissionApplications";
import { normalizeAdmissionApplicationPrivate } from "@/lib/firestore/admissionApplicationPrivate";
import { formatRoundDate, formatRoundDeadline } from "@/lib/admissions/window";
import ApplyFlow from "@/features/admissions/ApplyFlow";
import styles from "./apply.module.css";

/**
 * `/apply/[roundId]` - and note WHERE it lives.
 *
 * In `(public)`, not `(app)`, for the same reason the course apply page is:
 * applying is open to any signed-in account INCLUDING role `pending`, and
 * `(app)/layout.tsx` redirects a pending account to `/pending-approval`.
 * Putting this page behind that layout would lock out exactly the people it
 * exists for, the ones who made an account at the fair on Monday.
 *
 * It is also NOT in `src/proxy.ts`'s protected prefixes, deliberately: a
 * signed-out visitor gets the sign-in gate card below, with the return address
 * in the link, rather than a redirect to `/login` from which the round is
 * invisible. Discovery matters here; the routes behind the form do the real
 * enforcement.
 *
 * ## Everything is loaded here, on the server
 *
 * `admissionRounds`, its `stages` subcollection and `admissionApplications`
 * are all `allow read, write: if false`, so there is no client-direct read to
 * fall back on. Rather than have the island fetch on mount and flash a
 * spinner at somebody standing in a queue, the page reads all three through
 * the Admin SDK and hands the island its opening state. The same serialisers
 * the API routes use are called here, so the two cannot disagree about what an
 * applicant may see, and the release filter is applied in exactly one place.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ roundId: string }> };

type Loaded = {
  round: ApplicantRound;
  stages: ApplicantStage[];
  application: ApplicantApplication | null;
  /** The unserialised deadline, for the page's own chrome. */
  closesAt: Date | null;
  opensAt: Date | null;
};

/**
 * The round, its stages and (when signed in) the caller's own row.
 *
 * Returns null for a round that does not exist, is still a draft, or has been
 * archived. All three answer the same way: which of them it is says something
 * about NAISI's plans that a visitor has no business reading off a page.
 */
async function loadRound(roundId: string, uid: string | null): Promise<Loaded | null> {
  const db = getAdminDb();
  if (!db) return null;

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) return null;
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});
  if (round.archived || round.status === "draft") return null;

  const now = new Date();
  const stagesSnap = await roundRef.collection(STAGES_SUBCOLLECTION).get();
  const stages = stagesSnap.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order)
    .map((stage) => serialiseStageForApplicant(stage, round, now));

  let application: ApplicantApplication | null = null;
  if (uid) {
    const [appSnap, privateSnap] = await Promise.all([
      db.collection("admissionApplications").doc(admissionApplicationId(roundId, uid)).get(),
      db
        .collection("admissionApplicationPrivate")
        .doc(admissionApplicationPrivateId(roundId, uid))
        .get(),
    ]);
    if (appSnap.exists) {
      application = serialiseApplicationForOwner(
        normalizeAdmissionApplication(
          appSnap.id,
          appSnap.data() ?? {},
          round.availabilityGrid,
        ),
        privateSnap.exists
          ? normalizeAdmissionApplicationPrivate(privateSnap.id, privateSnap.data() ?? {})
              .accessRequirements
          : "",
      );
    }
  }

  return {
    round: serialiseRoundForApplicant(round, now),
    stages,
    application,
    closesAt: round.closesAt,
    opensAt: round.opensAt,
  };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { roundId } = await params;
  const loaded = await loadRound(roundId, null);
  if (!loaded) return { title: "Applications", robots: { index: false, follow: true } };
  const { round } = loaded;
  const state = round.windowState;
  return {
    title: `${state === "open" ? "Apply" : "Applications"}: ${round.label}`,
    description:
      state === "open"
        ? `Apply to ${round.label}. Open to anyone with a NAISI account, including one you make in the next minute.`
        : state === "not-yet"
          ? `Applications for ${round.label} have not opened yet.`
          : `Applications for ${round.label} have closed.`,
    // A personal form is no use in search results, and the page renders
    // per-viewer state.
    robots: { index: false, follow: true },
  };
}

export default async function ApplyPage({ params }: Params) {
  const { roundId } = await params;
  const user = await getCurrentUser();
  const loaded = await loadRound(roundId, user?.uid ?? null);

  // A draft or archived round is a 404 rather than a "closed" card: unlike a
  // course, whose curriculum stays up between runs, a round nobody has opened
  // is not a public object at all.
  if (!loaded) notFound();

  const { round, stages, application, closesAt, opensAt } = loaded;
  const open = round.windowState === "open";
  const notYet = round.windowState === "not-yet";
  const returnTo = `/apply/${encodeURIComponent(roundId)}`;
  const nextParam = encodeURIComponent(returnTo);

  const dates = [
    open && closesAt ? `Closes ${formatRoundDeadline(closesAt)}` : null,
    notYet && opensAt ? `Opens ${formatRoundDate(opensAt)}` : null,
    round.decisionsByDate ? `Decisions by ${round.decisionsByDate}` : null,
  ].filter(Boolean) as string[];

  return (
    <section className={styles.page}>
      <div className="container">
        <header className={styles.hero}>
          <Badge tone="accent">{round.academicYear || "Applications"}</Badge>
          <h1 className={styles.title}>{round.label}</h1>
          {dates.length > 0 ? (
            <p className={styles.dates}>
              {dates.map((bit, index) => (
                <span key={bit}>
                  {index > 0 ? (
                    <span aria-hidden="true" className={styles.dot}>
                      ·
                    </span>
                  ) : null}
                  {bit}
                </span>
              ))}
            </p>
          ) : null}
          {round.blurb ? <p className={styles.lede}>{round.blurb}</p> : null}
        </header>

        {!user ? (
          <Card padding="lg" className={styles.gate}>
            <h2 className={styles.gateTitle}>
              {open ? "Sign in to apply" : "Sign in to check your application"}
            </h2>
            <p className={styles.gateBody}>
              {open ? (
                <>
                  Applications are tied to a NAISI account so your answers save
                  as you write them and you hear the outcome.{" "}
                  <strong>Any account can apply</strong>, including one you make
                  in the next minute, and one still waiting on committee
                  approval.
                </>
              ) : notYet ? (
                <>
                  There is nothing to fill in yet. When the form opens it will
                  be tied to a NAISI account, so making one now is the whole of
                  the head start available.
                </>
              ) : (
                <>
                  Applications have closed. If you sent one, sign in and it will
                  be here.
                </>
              )}
            </p>
            {/* An anchor styled as the primary action: Button renders a real
                <button> and takes no href. `next` rides through sign-in AND
                through registration, so a brand-new account lands back on this
                form rather than on /pending-approval. */}
            <Link href={`/login?next=${nextParam}`} className={styles.button}>
              {open ? "Sign in to apply" : "Sign in"}
            </Link>
            {open || notYet ? (
              <p className={styles.gateNote}>
                No account yet?{" "}
                <Link href={`/register?next=${nextParam}`} className={styles.gateLink}>
                  Create one
                </Link>{" "}
                {open
                  ? "and we will bring you straight back to this form."
                  : "and this page will have the form on it the day it opens."}
              </p>
            ) : null}
          </Card>
        ) : user.role === "rejected" ? (
          <Card padding="lg" className={styles.gate}>
            <h2 className={styles.gateTitle}>This account cannot apply</h2>
            <p className={styles.gateBody}>
              Your NAISI account is not able to send applications. If you think
              that is a mistake, reply to any email from us and we will take a
              look.
            </p>
          </Card>
        ) : (
          <ApplyFlow
            round={round}
            stages={stages}
            application={application}
            pendingNote={user.role === "pending"}
          />
        )}
      </div>
    </section>
  );
}
