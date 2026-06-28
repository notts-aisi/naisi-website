/**
 * Versioned, dated legal policies — the single source of truth for the Terms of
 * Use and Privacy Policy version history.
 *
 * When a policy's wording changes: add a new content module under
 * `src/content/legal/<policy>/v<N>.tsx`, register it in
 * `src/content/legal/registry.tsx`, and PREPEND a new entry here (newest first).
 * `CURRENT_POLICY_VERSION` changes with it. We store the version a user accepted
 * and when (`policyVersion` + `policyAgreedAt`), so a future PR can detect anyone
 * who agreed to an older version and require them to re-consent on sign-in.
 *
 * The /<policy> page renders the current version; /<policy>/versions lists the
 * history; /<policy>/v/[version] renders a specific archived version.
 */
export type PolicyKey = "terms" | "privacy";

export type PolicyVersion = { version: number; lastUpdated: string };

export const POLICIES: Record<
  PolicyKey,
  {
    label: string;
    href: string;
    /** Newest first — entry [0] is the current version. */
    versions: PolicyVersion[];
  }
> = {
  terms: {
    label: "Terms of Use",
    href: "/terms",
    versions: [{ version: 1, lastUpdated: "25 May 2026" }],
  },
  privacy: {
    label: "Privacy Policy",
    href: "/privacy",
    versions: [
      { version: 2, lastUpdated: "29 June 2026" },
      { version: 1, lastUpdated: "25 May 2026" },
    ],
  },
};

/** The current (newest) version of a policy. */
export function currentPolicy(key: PolicyKey): PolicyVersion {
  return POLICIES[key].versions[0];
}

/**
 * A single agreement version string covering BOTH policies, stored against a
 * user when they accept. Changes whenever either policy's version changes.
 */
export const CURRENT_POLICY_VERSION = `terms.${currentPolicy("terms").version}+privacy.${currentPolicy("privacy").version}`;
