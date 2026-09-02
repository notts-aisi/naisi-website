"use client";

import CountedTextarea from "@/components/ui/CountedTextarea";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import {
  answerMaxLength,
  DIETARY_ALLERGIES,
  DIETARY_NONE,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";
import styles from "./FormRenderer.module.css";

type Props = {
  questions: FormQuestion[];
  answers: Record<string, RsvpAnswer>;
  onChange: (next: Record<string, RsvpAnswer>) => void;
  disabled?: boolean;
  /**
   * Per-question problems, keyed by question id. `validateAnswers` returns the
   * offending `questionId` alongside its message, so a caller can put the
   * sentence against the field it belongs to instead of only at the top of the
   * form. Each one renders as a live region wired to the input through
   * aria-describedby, so a screen reader announces it without the user having
   * to go looking.
   */
  errors?: Record<string, string>;
};

export default function FormRenderer({
  questions,
  answers,
  onChange,
  disabled,
  errors,
}: Props) {
  function set(id: string, value: RsvpAnswer) {
    onChange({ ...answers, [id]: value });
  }

  return (
    <div className={styles.wrap}>
      {questions.map((q) => {
        const helpId = `${q.id}-help`;
        const errorId = `${q.id}-error`;
        const error = errors?.[q.id];
        const describedBy =
          [q.helpText ? helpId : null, error ? errorId : null]
            .filter(Boolean)
            .join(" ") || undefined;
        const invalid = error ? true : undefined;
        const limit = answerMaxLength(q);

        const label = (
          <span className={styles.label}>
            {q.label}
            {q.required && <span className={styles.required}> *</span>}
          </span>
        );
        const help = q.helpText ? (
          <p id={helpId} className={styles.help}>
            {q.helpText}
          </p>
        ) : null;
        const errorNote = error ? (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        ) : null;

        switch (q.type) {
          case "shortText": {
            const value = (answers[q.id] as string | undefined) ?? "";
            return (
              <label key={q.id} className={styles.field}>
                {label}
                {help}
                <input
                  type="text"
                  className={styles.input}
                  value={value}
                  onChange={(e) => set(q.id, e.target.value)}
                  disabled={disabled}
                  placeholder={q.placeholder}
                  required={q.required}
                  maxLength={limit}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                />
                {errorNote}
              </label>
            );
          }
          case "longText": {
            const value = (answers[q.id] as string | undefined) ?? "";
            return (
              <label key={q.id} className={styles.field}>
                {label}
                {help}
                <CountedTextarea
                  className={styles.textarea}
                  value={value}
                  max={limit}
                  onChange={(e) => set(q.id, e.target.value)}
                  disabled={disabled}
                  placeholder={q.placeholder}
                  required={q.required}
                  rows={3}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                />
                {errorNote}
              </label>
            );
          }
          case "singleSelect": {
            const value = (answers[q.id] as string | undefined) ?? "";
            const opts = q.options.map((o) => o.trim()).filter(Boolean);
            return (
              <label key={q.id} className={styles.field}>
                {label}
                {help}
                <ResponsiveSelect
                  value={value}
                  onChange={(next) => set(q.id, next)}
                  options={[
                    { value: "", label: "Pick one…", disabled: true },
                    ...opts.map((opt) => ({ value: opt, label: opt })),
                  ]}
                  disabled={disabled}
                  ariaLabel={q.label || "Pick one"}
                />
                {errorNote}
              </label>
            );
          }
          case "multiSelect": {
            const opts = q.options.map((o) => o.trim()).filter(Boolean);

            if (q.allowOther || q.noneOption) {
              const noneLabel = q.noneOption;
              const raw = answers[q.id];
              const current =
                raw && typeof raw === "object" && !Array.isArray(raw)
                  ? (raw as { checked: string[]; other: string })
                  : { checked: [], other: "" };
              const noneSelected = noneLabel
                ? current.checked.includes(noneLabel)
                : false;
              const realChecked = current.checked.filter((c) => c !== noneLabel);
              const hasPick =
                realChecked.length > 0 || current.other.trim() !== "";
              return (
                <fieldset
                  key={q.id}
                  className={`${styles.field} ${styles.choiceField}`}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                >
                  <legend className={styles.legend}>
                    {q.label}
                    {q.required && <span className={styles.required}> *</span>}
                  </legend>
                  {help}
                  <div className={styles.checkGrid}>
                    {opts.map((opt) => (
                      <label key={opt} className={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={realChecked.includes(opt)}
                          disabled={disabled || noneSelected}
                          onChange={(e) => {
                            const nextChecked = e.target.checked
                              ? [...realChecked, opt]
                              : realChecked.filter((v) => v !== opt);
                            set(q.id, {
                              checked: nextChecked,
                              other: current.other,
                            });
                          }}
                        />
                        <span>{opt}</span>
                      </label>
                    ))}
                  </div>
                  {q.allowOther && (
                    <>
                      <hr className={styles.divider} />
                      <div className={styles.subBlock}>
                        <span className={styles.subLabel}>Other</span>
                        <input
                          type="text"
                          className={styles.input}
                          value={current.other}
                          onChange={(e) =>
                            set(q.id, {
                              checked: realChecked,
                              other: e.target.value,
                            })
                          }
                          disabled={disabled || noneSelected}
                          placeholder="Anything else not listed above"
                          maxLength={limit}
                        />
                      </div>
                    </>
                  )}
                  {noneLabel && (
                    <>
                      <hr className={styles.divider} />
                      <label className={styles.noneRow}>
                        <input
                          type="checkbox"
                          checked={noneSelected}
                          disabled={disabled || hasPick}
                          onChange={(e) =>
                            set(
                              q.id,
                              e.target.checked
                                ? { checked: [noneLabel], other: "" }
                                : { checked: [], other: "" },
                            )
                          }
                        />
                        <span>{noneLabel}</span>
                      </label>
                    </>
                  )}
                  {errorNote}
                </fieldset>
              );
            }
            const value = (answers[q.id] as string[] | undefined) ?? [];
            return (
              <fieldset
                key={q.id}
                className={`${styles.field} ${styles.choiceField}`}
                aria-invalid={invalid}
                aria-describedby={describedBy}
              >
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
                {help}
                <div className={styles.checkGrid}>
                  {opts.map((opt) => {
                    const checked = value.includes(opt);
                    return (
                      <label key={opt} className={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...value, opt]
                              : value.filter((v) => v !== opt);
                            set(q.id, next);
                          }}
                        />
                        <span>{opt}</span>
                      </label>
                    );
                  })}
                </div>
                {errorNote}
              </fieldset>
            );
          }
          case "yesNo": {
            const value = answers[q.id];
            return (
              <fieldset
                key={q.id}
                className={styles.field}
                aria-invalid={invalid}
                aria-describedby={describedBy}
              >
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
                {help}
                <div className={styles.radioRow}>
                  <label className={styles.radioChoice}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={value === true}
                      disabled={disabled}
                      onChange={() => set(q.id, true)}
                      required={q.required}
                    />
                    <span>Yes</span>
                  </label>
                  <label className={styles.radioChoice}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={value === false}
                      disabled={disabled}
                      onChange={() => set(q.id, false)}
                    />
                    <span>No</span>
                  </label>
                </div>
                {errorNote}
              </fieldset>
            );
          }
          case "dietaryAllergies": {
            const raw = answers[q.id];
            const current =
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as { checked: string[]; other: string })
                : { checked: [], other: "" };
            const noneSelected = current.checked.includes(DIETARY_NONE);
            const realChecked = current.checked.filter((c) => c !== DIETARY_NONE);
            const hasRequirement =
              realChecked.length > 0 || current.other.trim() !== "";
            return (
              <fieldset
                key={q.id}
                className={`${styles.field} ${styles.choiceField}`}
                aria-invalid={invalid}
                aria-describedby={describedBy}
              >
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
                {help}
                <p className={styles.helper}>
                  Tick anything we need to keep off your plate, whether a diet
                  you follow or an allergy. Tick only genuine requirements, not
                  mild preferences.
                </p>
                <div className={styles.checkGrid}>
                  {DIETARY_ALLERGIES.map((a) => (
                    <label key={a} className={styles.checkRow}>
                      <input
                        type="checkbox"
                        checked={realChecked.includes(a)}
                        disabled={disabled || noneSelected}
                        onChange={(e) => {
                          const nextChecked = e.target.checked
                            ? [...realChecked, a]
                            : realChecked.filter((v) => v !== a);
                          set(q.id, { checked: nextChecked, other: current.other });
                        }}
                      />
                      <span>{a}</span>
                    </label>
                  ))}
                </div>

                <hr className={styles.divider} />

                <div className={styles.subBlock}>
                  <span className={styles.subLabel}>Anything else?</span>
                  <p className={styles.subHint}>
                    Other needs, or strict religious requirements not met by
                    vegetarian or vegan.
                  </p>
                  <input
                    type="text"
                    className={styles.input}
                    value={current.other}
                    onChange={(e) =>
                      set(q.id, { checked: realChecked, other: e.target.value })
                    }
                    disabled={disabled || noneSelected}
                    placeholder="e.g. strict halal, no shellfish"
                    maxLength={limit}
                  />
                </div>

                <p className={styles.accommodationNote}>
                  We do our best to accommodate dietary requirements, but
                  can&apos;t promise a suitable meal at every event. If that
                  happens, we&apos;ll do our best to let you know beforehand.
                </p>

                <hr className={styles.divider} />

                <label className={styles.noneRow}>
                  <input
                    type="checkbox"
                    checked={noneSelected}
                    disabled={disabled || hasRequirement}
                    onChange={(e) =>
                      set(
                        q.id,
                        e.target.checked
                          ? { checked: [DIETARY_NONE], other: "" }
                          : { checked: [], other: "" },
                      )
                    }
                  />
                  <span>No dietary requirements</span>
                </label>
                {errorNote}
              </fieldset>
            );
          }
        }
      })}
    </div>
  );
}
