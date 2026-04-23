import Link from "next/link";
import { getAdminDb } from "@/lib/firebase/admin";
import { confirmUniEmailVerification } from "@/lib/email/confirmUniEmailVerification";

type SearchParams = { t?: string | string[] };

type Result =
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

/**
 * Magic-link landing page. Hit from the email button; confirms the token
 * server-side, tells the user they can close the tab (their original
 * register tab is subscribed via onSnapshot and will update on its own).
 *
 * Calls `confirmUniEmailVerification` directly rather than POSTing to the
 * sibling API route. An HTTP roundtrip back to our own service would have
 * to reuse the incoming request's `host` header, which — under Firebase
 * App Hosting — is the internal Cloud Run revision URL (e.g.
 * `t-XXX---<service>-<suffix>.a.run.app`) rather than the public hostname.
 * That internal URL requires IAM auth we don't pass, so the roundtrip
 * always returned 403 and the page rendered as if the link was invalid.
 */
export default async function VerifyEmailLandingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const raw = params.t;
  const signed = Array.isArray(raw) ? raw[0] : raw;

  let result: Result;
  if (!signed) {
    result = {
      status: "error",
      message: "This link is missing its verification token.",
    };
  } else {
    const db = getAdminDb();
    if (!db) {
      console.error("[verify-email/page] getAdminDb returned null");
      result = {
        status: "error",
        message: "We couldn't reach the verification service. Try again in a moment.",
      };
    } else {
      const r = await confirmUniEmailVerification(db, signed);
      result = r.ok
        ? { status: "ok", email: r.email }
        : { status: "error", message: r.error };
    }
  }

  return (
    <main
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-8) var(--space-4)",
      }}
    >
      <div
        style={{
          maxWidth: "32rem",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-8)",
          textAlign: "center",
        }}
      >
        {result.status === "ok" ? (
          <>
            <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
              University email verified
            </h1>
            <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-4)" }}>
              We&apos;ve confirmed you own <strong>{result.email}</strong>.
            </p>
            <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-6)" }}>
              You can close this tab now — your registration tab will update
              automatically. If you closed it, head back to{" "}
              <Link href="/register" style={{ color: "var(--color-accent)" }}>
                the sign-up page
              </Link>{" "}
              and finish from there.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: "var(--text-2xl)", margin: "0 0 var(--space-3)" }}>
              Couldn&apos;t verify this link
            </h1>
            <p style={{ color: "var(--color-text-muted)", margin: "0 0 var(--space-6)" }}>
              {result.message} If your original link expired, head back to your
              registration tab and click &quot;Resend&quot; — we&apos;ll email a
              fresh one.
            </p>
            <Link
              href="/register"
              style={{
                display: "inline-block",
                padding: "var(--space-2) var(--space-4)",
                background: "var(--color-accent)",
                color: "white",
                borderRadius: "var(--radius-md)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              Go to the sign-up page
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
