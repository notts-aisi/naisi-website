import type { Metadata } from "next";
import LegalPolicyPage from "@/components/legal/LegalPolicyPage";

const TITLE = "Terms of service";
const DESCRIPTION =
  "The terms you agree to when you use the Nottingham AI Safety Initiative website.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "article" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default function TermsPage() {
  return <LegalPolicyPage policy="terms" />;
}
