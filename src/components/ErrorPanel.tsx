"use client";

import Link from "next/link";
import Button from "@/components/ui/Button";
import styles from "./ErrorPanel.module.css";

type Props = {
  /** Short, plain statement of what happened. */
  title: string;
  /** One or two sentences. Say what the reader can do, not what threw. */
  description: string;
  /** Next's reset() from the error boundary. Omit on not-found pages. */
  reset?: () => void;
  /** Next's error.digest. Rendered small, only when present. */
  digest?: string;
  /** Where "back to safety" goes. Defaults to the public homepage. */
  homeHref?: string;
  homeLabel?: string;
};

/**
 * The shared body of every error and not-found page.
 *
 * Unlike src/app/global-error.tsx, these render INSIDE the root layout, so
 * tokens.css, the fonts and the Button primitive are all available and there
 * is no reason to hand-roll any of it.
 *
 * The reload affordance is not decoration. Every one of these screens is
 * reachable inside an installed home-screen app, where there is no URL bar
 * and no reload button, so a dead end here means force-quitting the app.
 */
export default function ErrorPanel({
  title,
  description,
  reset,
  digest,
  homeHref = "/",
  homeLabel = "Go to the homepage",
}: Props) {
  return (
    <div className={styles.panel}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
      <div className={styles.actions}>
        {reset ? (
          <Button onClick={reset}>Try again</Button>
        ) : null}
        <Link href={homeHref} className={styles.secondary}>
          {homeLabel}
        </Link>
      </div>
      {digest ? <p className={styles.digest}>Reference: {digest}</p> : null}
    </div>
  );
}
