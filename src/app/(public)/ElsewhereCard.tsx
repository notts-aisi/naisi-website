"use client";

import { useTilt } from "@/hooks/useTilt";
import styles from "./ElsewhereRow.module.css";

type Item = {
  platform: string;
  href: string;
  primary: string;
  description: string;
};

export default function ElsewhereCard({ item }: { item: Item }) {
  const ref = useTilt<HTMLAnchorElement>({ max: 6, perspective: 900 });

  return (
    <a
      ref={ref}
      href={item.href}
      target="_blank"
      rel="noreferrer noopener"
      className={styles.card}
    >
      <span className={styles.platform}>{item.platform}</span>
      <span className={styles.primary}>{item.primary}</span>
      <span className={styles.description}>{item.description}</span>
      <span className={styles.arrow} aria-hidden="true">→</span>
    </a>
  );
}
