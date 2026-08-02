import type { Metadata } from "next";
import PolicyVersionsIndex from "@/components/legal/PolicyVersionsIndex";

export const metadata: Metadata = {
  title: "Terms of service — version history",
  description: "Every published version of the NAISI Terms of Use.",
};

export default function TermsVersionsPage() {
  return <PolicyVersionsIndex policy="terms" />;
}
