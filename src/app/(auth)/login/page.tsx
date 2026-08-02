import { Suspense } from "react";
import Card from "@/components/ui/Card";
import AuthEntry from "../AuthEntry";

export default function LoginPage() {
  // useSearchParams (inside AuthEntry) must sit under a Suspense boundary in
  // Next 16 so the bailout-to-CSR is explicit at build time.
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <AuthEntry initialMode="signin" />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <Card padding="lg" style={{ width: "100%", maxWidth: "26rem", minHeight: "14rem" }}>
      <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
    </Card>
  );
}
