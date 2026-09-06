"use client";

import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Drawer from "@/components/ui/Drawer";
import MemberName from "@/components/ui/MemberName";
import Modal from "@/components/ui/Modal";
import type { CirculationDoc, ResponseDoc } from "@/lib/firestore/circulations";
import {
  pagesOf,
  type WorksheetQuestion,
  type WorksheetSection,
} from "@/lib/firestore/worksheets";
import { maxWidth } from "@/theme/breakpoints";
import ActivityLine from "./ActivityLine";
import AnswerSummary from "./AnswerSummary";
import ReviewSlot from "./ReviewSlot";
import { responseStateLabel, responseStateTone } from "./circulationView";
import styles from "./ResponseView.module.css";

/**
 * One recipient's answers, read-only.
 *
 * Modal above --bp-md, Drawer below, which is the house pattern for a panel
 * that has to work at both widths (`SubtaskDetailModal`, `PersonSelector`).
 *
 * `closeAboveRem` is pushed out of reach on purpose. Drawer's own job is to
 * shut itself when a phone rotates into tablet width, because the nav it
 * usually holds has a desktop home to go back to. This one has a Modal to
 * become instead, and the swap below already happens at exactly that width, so
 * leaving Drawer's default in place would race the swap and close the whole
 * view on a rotate. Somebody reading an answer would simply lose it.
 *
 * REVIEW IS WAVE 2. The feedback and scoring boxes are not here yet;
 * `ReviewSlot` marks where they go, once per question and once at the end, so
 * building them moves nothing on this page.
 */

/**
 * A width no viewport reaches, so Drawer's auto-close never fires. Stated as a
 * named constant because a bare 999 in the JSX reads as a mistake.
 */
const NEVER_AUTO_CLOSE_REM = 999;

type Props = {
  circulation: CirculationDoc;
  response: ResponseDoc;
  /** Resolved display name for the recipient. */
  name: string;
  onClose: () => void;
};

export default function ResponseView({ circulation, response, name, onClose }: Props) {
  const mobileSubscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(maxWidth("md"));
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const isMobile = useSyncExternalStore(
    mobileSubscribe,
    () => window.matchMedia(maxWidth("md")).matches,
    () => false,
  );

  // Page breaks are separators, not content: `pagesOf` drops them, and the
  // read-only view has no reason to paginate. Sections survive as headings
  // because an answer without the heading it sat under can read as an answer
  // to the wrong question.
  //
  // The predicate is what tells the TYPE system that, since `pagesOf` returns
  // the wide `WorksheetItem[][]`. Without it the branch below narrows to
  // "question or page break" and every field read on a question is an error.
  const items = useMemo(
    () =>
      pagesOf(circulation.items)
        .flat()
        .filter(
          (item): item is WorksheetQuestion | WorksheetSection => item.kind !== "pageBreak",
        ),
    [circulation.items],
  );

  const label = `Answers from ${name}`;

  const body: ReactNode = (
    <div className={styles.view}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          <MemberName name={name} />
        </h2>
        <div className={styles.meta}>
          <Chip size="sm" tone={responseStateTone(response.state)}>
            {responseStateLabel(response)}
          </Chip>
          {response.submittedAt && (
            <span className={styles.submitted}>
              Submitted{" "}
              {response.submittedAt.toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </div>
        <ActivityLine activity={response.activity} />
      </header>

      {items.length === 0 ? (
        <p className={styles.empty}>This worksheet has no questions.</p>
      ) : (
        <ol className={styles.items}>
          {items.map((item) =>
            item.kind === "section" ? (
              <li key={item.id} className={styles.section}>
                <h3 className={styles.sectionHeading}>{item.heading}</h3>
              </li>
            ) : (
              <li key={item.id} className={styles.item}>
                <h3 className={styles.question}>
                  {item.title}
                  {item.required && (
                    <span className={styles.required} title="Required question">
                      {" "}
                      required
                    </span>
                  )}
                </h3>
                <AnswerSummary question={item} answer={response.answers[item.id]} />
                <ReviewSlot
                  scope="question"
                  questionId={item.id}
                  responseUid={response.uid}
                  circulationId={circulation.id}
                />
              </li>
            ),
          )}
        </ol>
      )}

      <ReviewSlot scope="overall" responseUid={response.uid} circulationId={circulation.id} />

      <footer className={styles.footer}>
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open onClose={onClose} ariaLabel={label} closeAboveRem={NEVER_AUTO_CLOSE_REM}>
        {body}
      </Drawer>
    );
  }

  return (
    <Modal open onClose={onClose} ariaLabel={label} width="md">
      {body}
    </Modal>
  );
}
