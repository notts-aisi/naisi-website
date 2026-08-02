import type { Metadata } from "next";
import LegalPolicyPage from "@/components/legal/LegalPolicyPage";

const TITLE = "Privacy policy";
const DESCRIPTION =
  "How the Nottingham AI Safety Initiative collects, uses, and looks after your personal data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "article" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function PrivacyPage() {
  return <LegalPolicyPage policy="privacy" />;
}
