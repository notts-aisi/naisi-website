"use client";

import ErrorPanel from "@/components/ErrorPanel";

/**
 * Error boundary for the sign-in and registration flow.
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
      title="Sign-in hit a problem"
      description="Something went wrong loading this step. Trying again usually works. If it keeps failing, a content blocker or VPN may be interfering."
      reset={reset}
      digest={error.digest}
      homeHref="/login"
      homeLabel="Back to sign in"
    />
  );
}
