import type { ReactNode } from "react";
import type { PolicyKey } from "@/lib/legal/policies";
import TermsContentV1 from "./terms/v1";
import PrivacyContentV1 from "./privacy/v1";
import PrivacyContentV2 from "./privacy/v2";
import PrivacyContentV3 from "./privacy/v3";
import PrivacyContentV4 from "./privacy/v4";

/** A version's self-contained content component, with header slots. */
export type LegalContent = (props: {
  meta?: ReactNode;
  banner?: ReactNode;
}) => ReactNode;

/**
 * Maps each policy version to its frozen content component. Add a new file +
 * entry here when a policy changes (and prepend the version in POLICIES).
 */
export const LEGAL_CONTENT: Record<PolicyKey, Record<number, LegalContent>> = {
  terms: { 1: TermsContentV1 },
  privacy: {
    1: PrivacyContentV1,
    2: PrivacyContentV2,
    3: PrivacyContentV3,
    4: PrivacyContentV4,
  },
};
