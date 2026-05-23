"use client";

import { useEffect, useState, useMemo } from "react";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import styles from "./DigitRoll.module.css";

/*
  DigitRoll — parses a leading number from `value` and animates each digit
  position independently from 0 → target on enter view (rolodex feel).
  Any non-numeric suffix renders static.

  Reduced motion → renders the value as plain text.
*/
export default function DigitRoll({ value }: { value: string }) {
  const { ref, inView } = useInViewOnce<HTMLSpanElement>();
  const [reduced, setReduced] = useState(false);

  const { digits, suffix } = useMemo(() => {
    const match = value.match(/^(\d+)(.*)$/);
    if (!match) return { digits: null, suffix: value };
    return { digits: match[1].split(""), suffix: match[2] };
  }, [value]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  if (!digits || reduced) {
    return <span ref={ref}>{value}</span>;
  }

  return (
    <span ref={ref} className={styles.roll}>
      {digits.map((d, i) => (
        <span key={i} className={styles.barrel} style={{ "--barrel-delay": `${i * 80}ms` } as React.CSSProperties}>
          <span className={`${styles.column} ${inView ? styles.settled : ""}`} style={{ "--target": d } as React.CSSProperties}>
            {Array.from({ length: 10 }, (_, n) => (
              <span key={n} className={styles.digit}>{n}</span>
            ))}
          </span>
        </span>
      ))}
      {suffix && <span className={styles.suffix}>{suffix}</span>}
    </span>
  );
}
