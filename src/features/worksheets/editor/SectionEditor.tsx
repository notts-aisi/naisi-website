"use client";

import BlockEditor from "@/components/blocks/BlockEditor";
import type { Block, BlockType } from "@/lib/firestore/newsletterBlocks";
import { WORKSHEET_LIMITS, type WorksheetSection } from "@/lib/firestore/worksheets";
import styles from "./QuestionEditor.module.css";

type Props = {
  section: WorksheetSection;
  onChange: (next: WorksheetSection) => void;
  /** The `{ownerId}` segment of `worksheet-images/{ownerId}/…`. See QuestionEditor. */
  storageOwnerId: string;
  disabled?: boolean;
};

/**
 * A section is a heading and a body, with no answer attached: the place a
 * worksheet explains what the next few questions are for.
 *
 * It shares `QuestionEditor.module.css` rather than owning a stylesheet with
 * three rules in it, because a section's fields have to line up with a
 * question's fields exactly. Two stylesheets that must agree are two
 * stylesheets that eventually do not.
 */
const BODY_BLOCK_TYPES: BlockType[] = ["richText", "image", "video"];

export default function SectionEditor({ section, onChange, storageOwnerId, disabled }: Props) {
  return (
    <div className={styles.wrap}>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor={`ws-heading-${section.id}`}>
          Section heading
        </label>
        <input
          id={`ws-heading-${section.id}`}
          type="text"
          className={styles.input}
          value={section.heading}
          onChange={(e) => onChange({ ...section, heading: e.target.value })}
          maxLength={WORKSHEET_LIMITS.sectionHeading}
          disabled={disabled}
          placeholder="e.g. How the term went"
        />
        <span className={styles.counter}>
          {section.heading.length} / {WORKSHEET_LIMITS.sectionHeading}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Introduction (optional)</span>
        <BlockEditor
          draftId={storageOwnerId}
          storagePrefix="worksheet-images"
          blocks={section.body}
          onChange={(body: Block[]) => onChange({ ...section, body })}
          disabled={disabled}
          allowedTypes={BODY_BLOCK_TYPES}
          compact
        />
      </div>
    </div>
  );
}
