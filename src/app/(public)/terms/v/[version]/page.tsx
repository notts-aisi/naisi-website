import type { Metadata } from "next";
import { notFound } from "next/navigation";
import LegalPolicyPage from "@/components/legal/LegalPolicyPage";
import { POLICIES } from "@/lib/legal/policies";

export const metadata: Metadata = {
  title: "Terms of service (archived version)",
  robots: { index: false },
};

export function generateStaticParams() {
  return POLICIES.terms.versions.map((v) => ({ version: String(v.version) }));
}

export default async function TermsVersionPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const n = Number(version);
  if (!Number.isInteger(n)) notFound();
  return <LegalPolicyPage policy="terms" version={n} archived />;
}
