import "server-only";

// Default 0.5 (Google's suggested cut). Override with RECAPTCHA_MIN_SCORE to
// test the gate locally — set it to e.g. 1.1 to force EVERY request to fail
// (proves the block works), then back to 0.5.
const SCORE_THRESHOLD = Number(process.env.RECAPTCHA_MIN_SCORE ?? "0.5");

/**
 * Verify a reCAPTCHA v3 token via Google's `siteverify`. Permissive when
 * unconfigured (no RECAPTCHA_SECRET) so dev works before the key is provisioned;
 * once the secret is set it ENFORCES — a missing token, a failed verification,
 * or a sub-threshold score all fail. Pairs with the client helper, which returns
 * null when there's no site key, so the two are enabled/disabled together.
 *
 * Swap the body for a reCAPTCHA Enterprise `createAssessment` call if we upgrade;
 * callers don't change.
 */
export async function verifyRecaptcha(
  token: string | undefined | null,
): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) return true; // not configured → open (dev / pre-launch)
  if (!token) return false;
  try {
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      success?: boolean;
      score?: number;
      action?: string;
      "error-codes"?: string[];
    };
    const pass = Boolean(data.success) && (data.score ?? 0) >= SCORE_THRESHOLD;
    // Surfaced in the dev server terminal so you can SEE it verifying each request.
    console.log(
      `[recaptcha] success=${data.success} score=${data.score} action=${data.action} threshold=${SCORE_THRESHOLD} → ${pass ? "PASS" : "BLOCK"}`,
      data["error-codes"] ?? "",
    );
    return pass;
  } catch (err) {
    console.error("[recaptcha] siteverify failed", err);
    return false;
  }
}
