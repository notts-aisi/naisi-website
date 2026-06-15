import type { Metadata } from "next";
import { notFound } from "next/navigation";
import LegalPolicyPage from "@/components/legal/LegalPolicyPage";
import { POLICIES } from "@/lib/legal/policies";

export const metadata: Metadata = {
  title: "Privacy policy (archived version)",
  robots: { index: false },
};

export function generateStaticParams() {
  return POLICIES.privacy.versions.map((v) => ({ version: String(v.version) }));
}

export default async function PrivacyVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const n = Number(version);
  if (!Number.isInteger(n)) notFound();
  return <LegalPolicyPage policy="privacy" version={n} archived />;
}
