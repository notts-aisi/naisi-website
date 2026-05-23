"use client";

import Link from "next/link";
import { useMagneticPull } from "@/hooks/useMagneticPull";
import styles from "./landing.module.css";

/*
  HeroCTAs — the two hero buttons wrapped with the magnetic-pull hook.
  Sits inside the Server Component page.tsx so the page can stay mostly
  server-rendered.
*/
export default function HeroCTAs() {
  const primaryRef = useMagneticPull<HTMLAnchorElement>({ radius: 130, strength: 0.18, cap: 8 });
  const secondaryRef = useMagneticPull<HTMLAnchorElement>({ radius: 130, strength: 0.14, cap: 6 });

  return (
    <div className={styles.ctas}>
      <Link
        ref={primaryRef}
        href="/register"
        className={styles.primaryCta}
      >
        Apply to join
      </Link>
      <Link
        ref={secondaryRef}
        href="#stay-in-touch"
        className={styles.secondaryCta}
      >
        Get the newsletter →
      </Link>
    </div>
  );
}
