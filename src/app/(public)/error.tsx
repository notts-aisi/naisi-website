"use client";

import ErrorPanel from "@/components/ErrorPanel";

/**
 * Error boundary for the public marketing site.
 *
 * Catches a throw inside this segment without taking down the shell around
 * it, so the header and nav stay usable and the user is not stranded.
 * src/app/global-error.tsx only fires when the root layout itself fails,
 * which is the rarer and much worse case.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorPanel
      title="Something went wrong"
      description="This page hit an error. Trying again usually works, and the rest of the site is unaffected."
      reset={reset}
      digest={error.digest}
      homeHref="/"
      homeLabel="Go to the homepage"
    />
  );
}
