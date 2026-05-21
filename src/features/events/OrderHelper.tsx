"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Select from "@/components/ui/Select";
import type {
  EventDoc,
  MultiSelectQuestion,
  RsvpDoc,
} from "@/lib/firestore/events";
import { analyseToppingExclusions, suggestOrder } from "./pizzaHelper";
import styles from "./OrderHelper.module.css";

type Props = {
  event: EventDoc;
  /** Confirmed RSVPs — the people the food is being ordered for. */
  rsvps: RsvpDoc[];
};

/**
 * Turns the "toppings to avoid" answers into an actionable order: how
 * exclusions cluster, which toppings are safe, and a rough pizza count. Sits on
 * the attendee dashboard for pizza-style events.
 */
export default function OrderHelper({ event, rsvps }: Props) {
  const multiSelects = event.signupForm.filter(
    (q): q is MultiSelectQuestion => q.type === "multiSelect",
  );
  const [questionId, setQuestionId] = useState(multiSelects[0]?.id ?? "");
  const [slicesPerPerson, setSlicesPerPerson] = useState(3);
  const [slicesPerPizza, setSlicesPerPizza] = useState(8);

  const question = multiSelects.find((q) => q.id === questionId) ?? multiSelects[0];

  // Cheap pure analysis (tens of RSVPs); React Compiler memoizes it for us.
  const analysis = question ? analyseToppingExclusions(rsvps, question) : null;

  if (!question || !analysis) return null;

  const suggestion = suggestOrder({
    headcount: analysis.headcount,
    restrictedCount: analysis.restrictedCount,
    slicesPerPerson,
    slicesPerPizza,
  });

  const excluded = analysis.toppingCounts.filter((t) => t.count > 0);
  const maxCount = excluded[0]?.count ?? 1;

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>Pizza order helper</h2>
      <p className={styles.hint}>
        Built from the &quot;toppings to avoid&quot; answers of {analysis.headcount}{" "}
        confirmed attendee{analysis.headcount === 1 ? "" : "s"}.
      </p>

      {multiSelects.length > 1 && (
        <div className={styles.picker}>
          <Select
            value={question.id}
            onChange={(e) => setQuestionId(e.target.value)}
            aria-label="Which question lists toppings to avoid"
          >
            {multiSelects.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label || "(untitled question)"}
              </option>
            ))}
          </Select>
        </div>
      )}

      {analysis.headcount === 0 ? (
        <Card padding="md">
          <p className={styles.muted}>
            No confirmed attendees yet. Numbers appear here as you approve RSVPs.
          </p>
        </Card>
      ) : (
        <>
          <div className={styles.grid}>
            <Card padding="md">
              <h3 className={styles.cardTitle}>How they align</h3>
              <ul className={styles.groupList}>
                {analysis.groups.map((g) => (
                  <li key={g.exclusions.join("|")} className={styles.groupRow}>
                    <span className={styles.groupCount}>{g.count}</span>
                    <span className={styles.groupDesc}>
                      {g.exclusions.length === 0
                        ? "will eat anything"
                        : `avoid ${g.exclusions.join(", ")}`}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card padding="md">
              <h3 className={styles.cardTitle}>Toppings to avoid</h3>
              {excluded.length === 0 ? (
                <p className={styles.muted}>Nobody flagged a topping to avoid.</p>
              ) : (
                <ul className={styles.tallyList}>
                  {excluded.map((t) => (
                    <li key={t.topping} className={styles.tallyRow}>
                      <span className={styles.tallyName}>{t.topping}</span>
                      <span className={styles.bar}>
                        <span
                          className={styles.barFill}
                          style={{ width: `${(t.count / maxCount) * 100}%` }}
                        />
                      </span>
                      <span className={styles.tallyCount}>{t.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {analysis.safeToppings.length > 0 && (
                <p className={styles.safe}>
                  Safe for everyone: {analysis.safeToppings.join(", ")}.
                </p>
              )}
            </Card>
          </div>

          <Card padding="md">
            <h3 className={styles.cardTitle}>Suggested order</h3>
            <p className={styles.recommend}>
              {analysis.unionExclusions.length === 0
                ? "Nobody has a restriction. Order whatever you like."
                : `Make at least one pizza with none of: ${analysis.unionExclusions.join(", ")}. That pizza works for all ${analysis.headcount} attendees.`}
            </p>
            <div className={styles.mathRow}>
              <label className={styles.mathField}>
                Slices per person
                <input
                  type="number"
                  min={1}
                  className={styles.numInput}
                  value={slicesPerPerson}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1 && n <= 50) {
                      setSlicesPerPerson(n);
                    }
                  }}
                />
              </label>
              <label className={styles.mathField}>
                Slices per pizza
                <input
                  type="number"
                  min={1}
                  className={styles.numInput}
                  value={slicesPerPizza}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1 && n <= 50) {
                      setSlicesPerPizza(n);
                    }
                  }}
                />
              </label>
            </div>
            <p className={styles.result}>
              <span className={styles.resultBig}>{suggestion.totalPizzas}</span>{" "}
              pizza{suggestion.totalPizzas === 1 ? "" : "s"} total.
              {analysis.restrictedCount > 0 &&
                ` Around ${suggestion.safePizzas} should avoid the toppings above; the other ${suggestion.freePizzas} can be anything.`}
            </p>
            <p className={styles.muted}>
              An estimate. Adjust the slice counts to match your plan.
            </p>
          </Card>

          {analysis.freeTextNotes.length > 0 && (
            <Card padding="md">
              <h3 className={styles.cardTitle}>Notes to check by hand</h3>
              <ul className={styles.noteList}>
                {analysis.freeTextNotes.map((n, i) => (
                  <li key={i}>
                    <strong>{n.name}:</strong> {n.text}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
