"use client";

import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import InitialsChip from "@/components/ui/InitialsChip";
import MemberName from "@/components/ui/MemberName";
import ProgressBar from "@/components/ui/ProgressBar";
import type { ResponseDoc } from "@/lib/firestore/circulations";
import ActivityLine from "./ActivityLine";
import { progressTone, responseStateLabel, responseStateTone } from "./circulationView";
import styles from "./RecipientRow.module.css";

/**
 * One recipient's line on the circulation page.
 *
 * NOT A `<table>`. The row is a grid whose tracks collapse to one column below
 * --bp-md, which a table cannot do without `display: block` on every element
 * and the loss of the semantics that were the reason to use a table. The
 * header below carries the column names for sighted readers; each cell carries
 * its own label for everybody else, so nothing depends on a header-to-cell
 * association the markup no longer has.
 *
 * The header lives in THIS file rather than in the page, because it and the
 * row have to agree about the track list and two files defining the same
 * `grid-template-columns` is a drift waiting to happen.
 */

export function RecipientTableHeader() {
  return (
    <div className={styles.header} aria-hidden="true">
      <span>Person</span>
      <span>Progress</span>
      <span>State</span>
      <span>Activity</span>
      <span />
    </div>
  );
}

type Props = {
  response: ResponseDoc;
  /** Resolved display name. Falls through `MemberName` for the empty case. */
  name: string;
  onView: () => void;
};

export default function RecipientRow({ response, name, onView }: Props) {
  const { progress } = response;
  return (
    <li className={styles.row}>
      <span className={styles.person}>
        <InitialsChip name={name} uid={response.uid} size="sm" />
        <span className={styles.name}>
          <MemberName name={name} />
        </span>
      </span>

      <span className={styles.progress}>
        <ProgressBar
          value={progress.answered}
          max={progress.total}
          tone={progressTone(response.state)}
          showLabel
          size="sm"
          ariaLabel={`${name}: ${progress.answered} of ${progress.total} questions answered`}
        />
      </span>

      <span className={styles.state}>
        <Chip size="sm" tone={responseStateTone(response.state)}>
          {responseStateLabel(response)}
        </Chip>
      </span>

      <span className={styles.activity}>
        <ActivityLine activity={response.activity} />
        {response.submittedAt && (
          <span className={styles.submitted}>
            Submitted{" "}
            {response.submittedAt.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}
          </span>
        )}
      </span>

      <span className={styles.action}>
        {/* Every row's button says "View" and the column header that would have
            named it is `aria-hidden`, so out of the visual context the label is
            the same five rows running. The aria-label carries the name the
            button is beside. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onView}
          aria-label={`View the answers from ${name}`}
        >
          View
        </Button>
      </span>
    </li>
  );
}
