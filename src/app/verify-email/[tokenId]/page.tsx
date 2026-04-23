import Link from "next/link";
import { headers } from "next/headers";

type SearchParams = { t?: string | string[] };

type Result =
  | { status: "ok"; email: string }
  | { status: "error"; message: string };

async function confirmOnServer(signed: string): Promise<Result> {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  // Absolute-URL fetch from a server component is the simplest way to reuse
  // the existing POST /confirm route; no shared handler refactor needed.
  const base = `${proto}://${host}`;
  try {
    const res = await fetch(`${base}/api/verify-email/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as
      | { ok: boolean; email: string }
      | { error: string }
      | null;
    if (!res.ok) {
      const message =
        (body && "error" in body && body.error) ||
        "This verification link is no longer valid.";
      return { status: "error", message };
    }
    return { status: "ok", email: (body as { email: string }).email };
  } catch (err) {
    console.error("[verify-email/page] confirm fetch failed", err);
    return {
      status: "error",
      message: "We couldn't reach the verification service. Try clicking the link again.",
    };
  }
}

/**
 * Magic-link landing page. Hit from the email button; confirms the token
 * server-side, tells the user they can close the tab (their original
 * register tab is subscribed via onSnapshot and will update on its own).
 */
export default async function VerifyEmailLandingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const raw = params.t;
  const signed = Array.isArray(raw) ? raw[0] : raw;
  const result: Result = signed
    ? await confirmOnServer(signed)
    : { status: "error", message: "This link is missing its verification token." };

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
