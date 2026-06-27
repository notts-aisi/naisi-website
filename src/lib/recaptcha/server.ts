import "server-only";

// Only consulted for v3-style responses (which carry a score). v2 Invisible
// responses have no score — a passed check is a binary pass — so this is inert
// under v2. Default 0.5 (Google's suggested v3 cut).
const SCORE_THRESHOLD = Number(process.env.RECAPTCHA_MIN_SCORE ?? "0.5");

/**
 * Verify a reCAPTCHA token via Google's `siteverify`. Permissive when
 * unconfigured (no RECAPTCHA_SECRET) so dev works before the key is provisioned;
 * once the secret is set it ENFORCES — a missing token or a failed verification
 * fail. Pairs with the client widget, which yields no token without a site key,
 * so the two are enabled/disabled together. Free `siteverify` (not Enterprise),
 * so it stays within the Firebase Spark / no-billing budget.
 *
 * Version-agnostic: a v2 Invisible response has no `score` (a passed check is a
 * binary pass), while v3 returns a score we still hold to the threshold. So the
 * same code accepts either key type unchanged.
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
