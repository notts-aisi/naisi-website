"use client";

import Select from "@/components/ui/Select";
import {
  DIETARY_ALLERGIES,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";
import styles from "./FormRenderer.module.css";

type Props = {
  questions: FormQuestion[];
  answers: Record<string, RsvpAnswer>;
  onChange: (next: Record<string, RsvpAnswer>) => void;
  disabled?: boolean;
};

export default function FormRenderer({ questions, answers, onChange, disabled }: Props) {
  function set(id: string, value: RsvpAnswer) {
    onChange({ ...answers, [id]: value });
  }

  return (
    <div className={styles.wrap}>
      {questions.map((q) => {
        const label = (
          <span className={styles.label}>
            {q.label}
            {q.required && <span className={styles.required}> *</span>}
          </span>
        );

        switch (q.type) {
          case "shortText": {
            const value = (answers[q.id] as string | undefined) ?? "";
            return (
              <label key={q.id} className={styles.field}>
                {label}
                <input
                  type="text"
                  className={styles.input}
                  value={value}
                  onChange={(e) => set(q.id, e.target.value)}
                  disabled={disabled}
                  placeholder={q.placeholder}
                  required={q.required}
                  maxLength={500}
                />
              </label>
            );
          }
          case "longText": {
            const value = (answers[q.id] as string | undefined) ?? "";
            return (
              <label key={q.id} className={styles.field}>
                {label}
                <textarea
                  className={styles.textarea}
                  value={value}
                  onChange={(e) => set(q.id, e.target.value)}
                  disabled={disabled}
                  placeholder={q.placeholder}
                  required={q.required}
                  rows={3}
                  maxLength={500}
                />
              </label>
            );
          }
          case "singleSelect": {
            const value = (answers[q.id] as string | undefined) ?? "";
            const opts = q.options.map((o) => o.trim()).filter(Boolean);
            return (
              <label key={q.id} className={styles.field}>
                {label}
                <Select
                  value={value}
                  onChange={(e) => set(q.id, e.target.value)}
                  disabled={disabled}
                  required={q.required}
                >
                  <option value="" disabled>
                    Pick one…
                  </option>
                  {opts.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Select>
              </label>
            );
          }
          case "multiSelect": {
            const opts = q.options.map((o) => o.trim()).filter(Boolean);
            if (q.allowOther) {
              const raw = answers[q.id];
              const current =
                raw && typeof raw === "object" && !Array.isArray(raw)
                  ? (raw as { checked: string[]; other: string })
                  : { checked: [], other: "" };
              return (
                <fieldset key={q.id} className={styles.field}>
                  <legend className={styles.legend}>
                    {q.label}
                    {q.required && <span className={styles.required}> *</span>}
                  </legend>
                  <div className={styles.checkGrid}>
                    {opts.map((opt) => {
                      const checked = current.checked.includes(opt);
                      return (
                        <label key={opt} className={styles.checkRow}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) => {
                              const nextChecked = e.target.checked
                                ? [...current.checked, opt]
                                : current.checked.filter((v) => v !== opt);
                              set(q.id, { checked: nextChecked, other: current.other });
                            }}
                          />
                          <span>{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                  <label className={styles.otherRow}>
                    <span className={styles.otherLabel}>Other</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={current.other}
                      onChange={(e) =>
                        set(q.id, { checked: current.checked, other: e.target.value })
                      }
                      disabled={disabled}
                      placeholder="Anything else not listed above"
                      maxLength={500}
                    />
                  </label>
                </fieldset>
              );
            }
            const value = (answers[q.id] as string[] | undefined) ?? [];
            return (
              <fieldset key={q.id} className={styles.field}>
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
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
              </fieldset>
            );
          }
          case "yesNo": {
            const value = answers[q.id];
            return (
              <fieldset key={q.id} className={styles.field}>
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
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
              </fieldset>
            );
          }
          case "dietaryAllergies": {
            const raw = answers[q.id];
            const current =
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as { checked: string[]; other: string })
                : { checked: [], other: "" };
            return (
              <fieldset key={q.id} className={styles.field}>
                <legend className={styles.legend}>
                  {q.label}
                  {q.required && <span className={styles.required}> *</span>}
                </legend>
                <p className={styles.helper}>
                  Tick anything that applies, however minor. The more we know, the
                  better we can cater for you.
                </p>
                <div className={styles.checkGrid}>
                  {DIETARY_ALLERGIES.map((a) => {
                    const checked = current.checked.includes(a);
                    return (
                      <label key={a} className={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) => {
                            const nextChecked = e.target.checked
                              ? [...current.checked, a]
                              : current.checked.filter((v) => v !== a);
                            set(q.id, { checked: nextChecked, other: current.other });
                          }}
                        />
                        <span>{a}</span>
                      </label>
                    );
                  })}
                </div>
                <label className={styles.otherRow}>
                  <span className={styles.otherLabel}>Other (optional)</span>
                  <input
                    type="text"
                    className={styles.input}
                    value={current.other}
                    onChange={(e) =>
                      set(q.id, { checked: current.checked, other: e.target.value })
                    }
                    disabled={disabled}
                    placeholder="e.g. coeliac, low-FODMAP, a severe nut allergy"
                    maxLength={500}
                  />
                </label>
              </fieldset>
            );
          }
        }
      })}
    </div>
  );
}
