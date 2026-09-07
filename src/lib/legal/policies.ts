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
    // v4 went out with the 6 September 2026 release, so its words are words
    // members agreed to at that sign-in. It is frozen: a digest in
    // tests/privacy-policy.test.mjs holds the file, and it renders unchanged
    // at /privacy/v/4.
    //
    // v5 is the notification grid's version, 7 September 2026. It names the
    // four rows and the two choices per row, and it puts important notices
    // from an event organiser or a group facilitator under performance of a
    // contract rather than consent, which is a new legal basis for a class of
    // message the notification settings do not switch off. That is a material
    // change to what v4 promised, so it moved the version rather than editing
    // v4, and every member is asked again at their next sign-in.
    //
    // Keep this comment ABOVE `versions:`, never between the `[` and the first
    // `{`: tests/funnel-harness-guards.test.mjs reads the current version out
    // of this file with a regex that allows only whitespace across that gap,
    // so a comment sitting there leaves the guard unable to read the very
    // number it exists to pin. Anywhere else in the file is fine.
    versions: [
      { version: 5, lastUpdated: "7 September 2026" },
      { version: 4, lastUpdated: "6 September 2026" },
      { version: 3, lastUpdated: "3 September 2026" },
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
