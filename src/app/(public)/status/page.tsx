import { Suspense } from "react";
import type { Metadata } from "next";
import StatusPage from "@/features/maintenance/StatusPage";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live availability of NAISI services and the maintenance notice log.",
};

export default function StatusRoute() {
  // Suspense boundary because StatusPage reads useSearchParams (the banner's
  // Details link arrives as /status?open=current to auto-open the popup).
  return (
    <Suspense fallback={null}>
      <StatusPage />
    </Suspense>
  );
}
