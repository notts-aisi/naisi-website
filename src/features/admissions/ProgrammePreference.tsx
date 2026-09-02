"use client";

import Switch from "@/components/ui/Switch";
import type { RoundProgrammePreference } from "@/lib/firestore/admissionRounds";
import type { ApplicationProgrammePreference } from "@/lib/firestore/admissionApplications";
import styles from "./ProgrammePreference.module.css";

/**
 * "Which of these would you like to be considered for?"
 *
 * The incubator and the fellowships run concurrently and start the same week,
 * so one round asks about both: an applicant picks at most one incubator
 * stream, ranks up to `maxRankedFellowships` fellowships, and answers whether
 * a fellowship place would do if the incubator cannot. That last question is
 * what makes an offer-fellowship decision an offer rather than a surprise.
 *
 * ## Ranking without a drag surface
 *
 * The ranking is built by PRESSING options in order, and each chosen option
 * shows its position. No drag-and-drop: the whole form has to work with one
 * thumb on a phone at a fair, and a reorderable list is the single most
 * fragile thing to build for touch. Pressing a chosen option removes it and
 * closes the gap, so a mistake costs one tap.
 *
 * Every id here is validated again on the server against the round's own
 * options (`readProgrammePreference`), so nothing on this screen is
 * load-bearing for what can be stored.
 */

type Props = {
  section: RoundProgrammePreference;
  value: ApplicationProgrammePreference;
  onChange: (next: ApplicationProgrammePreference) => void;
  readOnly?: boolean;
};

export default function ProgrammePreference({
  section,
  value,
  onChange,
  readOnly,
}: Props) {
  if (!section.enabled) return null;

  const cap = Math.max(1, section.maxRankedFellowships);
  const ranked = value.rankedFellowshipIds;

  function pickStream(id: string) {
    // Pressing the chosen stream again clears it: this is a preference, not a
    // required field, and a radio nobody can unset is a trap.
    onChange({ ...value, streamId: value.streamId === id ? null : id });
  }

  function toggleFellowship(id: string) {
    const at = ranked.indexOf(id);
    if (at !== -1) {
      const next = ranked.slice();
      next.splice(at, 1);
      onChange({ ...value, rankedFellowshipIds: next });
      return;
    }
    if (ranked.length >= cap) return;
    onChange({ ...value, rankedFellowshipIds: [...ranked, id] });
  }

  return (
    <div className={styles.wrap}>
      {section.streams.length > 0 ? (
        <fieldset className={styles.group} disabled={readOnly}>
          <legend className={styles.legend}>Research incubator stream</legend>
          <p className={styles.note}>
            Each week has core content plus material for your stream. Pick the
            one closest to how you want to spend the term; you can say more in
            your answers.
          </p>
          <div className={styles.options}>
            {section.streams.map((option) => {
              const on = value.streamId === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={styles.option}
                  data-selected={on ? "true" : "false"}
                  aria-pressed={on}
                  disabled={readOnly}
                  onClick={() => pickStream(option.id)}
                >
                  <span className={styles.optionLabel}>{option.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {section.fellowships.length > 0 ? (
        <fieldset className={styles.group} disabled={readOnly}>
          <legend className={styles.legend}>Fellowship preferences</legend>
          <p className={styles.note}>
            Press them in the order you would pick them, most wanted first. You
            can rank up to {cap}.
          </p>
          <div className={styles.options}>
            {section.fellowships.map((option) => {
              const at = ranked.indexOf(option.id);
              const on = at !== -1;
              const full = !on && ranked.length >= cap;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={styles.option}
                  data-selected={on ? "true" : "false"}
                  aria-pressed={on}
                  disabled={readOnly || full}
                  onClick={() => toggleFellowship(option.id)}
                >
                  <span className={styles.rank} aria-hidden="true">
                    {on ? at + 1 : ""}
                  </span>
                  <span className={styles.optionLabel}>{option.label}</span>
                  <span className="visually-hidden">
                    {on ? `ranked ${at + 1}` : full ? "ranking full" : "not ranked"}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {section.offerFellowshipFallback ? (
        <div className={styles.fallback}>
          <Switch
            checked={value.openToFellowship}
            onChange={(next) => onChange({ ...value, openToFellowship: next })}
            disabled={readOnly}
            label="If we cannot offer you an incubator place, I would take a fellowship place"
          />
          <p className={styles.note}>
            The incubator is smaller than the fellowships, so this is the
            difference between one answer and two. Saying no does not count
            against your incubator application.
          </p>
        </div>
      ) : null}
    </div>
  );
}
