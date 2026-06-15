import type { Metadata } from "next";
import PolicyVersionsIndex from "@/components/legal/PolicyVersionsIndex";

export const metadata: Metadata = {
  title: "Privacy policy — version history",
  description: "Every published version of the NAISI Privacy Policy.",
};

export default function PrivacyVersionsPage() {
  return <PolicyVersionsIndex policy="privacy" />;
}
