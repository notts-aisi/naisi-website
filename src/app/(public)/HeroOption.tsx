import type { ReactNode } from "react";
import styles from "./HeroOption.module.css";

interface Props {
  num: number;
  name: string;
  description: string;
  background: ReactNode;
}

/*
  A single labelled hero-background preview. Stacked four of these to
  let you scroll through and pick. After choosing, all four will be
  removed and the winning background wired into the real hero.
*/
export default function HeroOption({ num, name, description, background }: Props) {
  return (
    <section className={styles.option}>
      <div className={styles.bg}>{background}</div>
      <div className={styles.gradient} aria-hidden="true" />
      <div className={styles.label}>
        <span className={styles.optNum}>Option {num}</span>
        <h2 className={styles.name}>{name}</h2>
        <p className={styles.description}>{description}</p>
      </div>
    </section>
  );
}
