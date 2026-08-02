import "server-only";

// Only consulted for v3-style responses (which carry a score). v2 Invisible
// responses have no score — a passed check is a binary pass — so this is inert
// under v2. Default 0.5 (Google's suggested v3 cut).
const SCORE_THRESHOLD = Number(process.env.RECAPTCHA_MIN_SCORE ?? "0.5");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Boot warning: a production backend with no secret can't verify any token, so
// the gate fails CLOSED below (every challenge is rejected). Shout about it at
// module load so a misconfigured prod backend is obvious in the logs rather
// than silently blocking every sign-up. In development a missing secret is
// expected (the gate stays open), so we don't warn there.
if (IS_PRODUCTION && !process.env.RECAPTCHA_SECRET) {
  console.error(
    "[recaptcha] RECAPTCHA_SECRET is not set in production — reCAPTCHA verification will FAIL CLOSED (all challenges rejected, sign-up blocked). Set the secret on the App Hosting backend.",
  );
}

/**
 * Verify a reCAPTCHA token via Google's `siteverify`.
 *
 * Configured (RECAPTCHA_SECRET set): ENFORCES — a missing token or a failed
 * verification both fail. Pairs with the client widget, which yields no token
 * without a site key, so the two are enabled/disabled together.
 *
 * Unconfigured (no RECAPTCHA_SECRET):
 *  - development → OPEN (returns true) so local dev works before the key is
 *    provisioned;
 *  - production → FAIL CLOSED (returns false). An unconfigured gate in prod
 *    must not silently wave traffic through; this trades a self-inflicted
 *    sign-up outage (loud, recoverable by setting the secret) for the far worse
 *    silent-bypass. The boot warning above flags the misconfiguration.
 *
 * Free `siteverify` (not Enterprise), so it stays within the Firebase Spark /
 * no-billing budget.
 *
 * Version-agnostic: a v2 Invisible response has no `score` (a passed check is a
 * binary pass), while v3 returns a score we still hold to the threshold. So the
 * same code accepts either key type unchanged.
 */
export async function verifyRecaptcha(
  token: string | undefined | null,
): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) {
    if (IS_PRODUCTION) {
      console.error(
        "[recaptcha] no RECAPTCHA_SECRET in production → BLOCK (fail closed)",
      );
      return false;
    }
    return true; // dev / pre-launch only
  }
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
    // v2: no score → success alone is the pass. v3: hold the score to the
    // threshold. `score === undefined` distinguishes the two.
    const pass =
      Boolean(data.success) &&
      (data.score === undefined || data.score >= SCORE_THRESHOLD);
    // Surfaced in the dev server terminal so you can SEE it verifying each request.
    console.log(
      `[recaptcha] success=${data.success} score=${data.score ?? "n/a (v2)"} action=${data.action} threshold=${SCORE_THRESHOLD} → ${pass ? "PASS" : "BLOCK"}`,
      data["error-codes"] ?? "",
    );
    return pass;
  } catch (err) {
    console.error("[recaptcha] siteverify failed", err);
    return false;
  }
}
