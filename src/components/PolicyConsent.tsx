"use client";

import Link from "next/link";
import { POLICIES } from "@/lib/legal/policies";

/**
 * Required "I agree to the Terms + Privacy Policy" checkbox for the signup
 * forms. The label only wraps the leading text (so clicking the policy links
 * opens them — in a new tab — rather than toggling the box). The accepted
 * version + timestamp are stamped server-side / at registration, not here.
 */
export default function PolicyConsent({
  checked,
  onChange,
  id = "policy-consent",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
}) {
  return (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          marginTop: "0.2rem",
          width: "1.15rem",
          height: "1.15rem",
          flex: "0 0 auto",
          accentColor: "var(--color-accent)",
          cursor: "pointer",
        }}
      />
      <span
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-text-muted)",
          lineHeight: 1.5,
        }}
      >
        <label htmlFor={id} style={{ cursor: "pointer" }}>
          I agree to NAISI&apos;s{" "}
        </label>
        <Link href={POLICIES.terms.href} target="_blank" style={{ color: "var(--color-accent)" }}>
          {POLICIES.terms.label}
        </Link>
        {" and "}
        <Link href={POLICIES.privacy.href} target="_blank" style={{ color: "var(--color-accent)" }}>
          {POLICIES.privacy.label}
        </Link>
        .
      </span>
    </div>
  );
}
