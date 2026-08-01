import type { Metadata } from "next";
import StatusPage from "@/features/maintenance/StatusPage";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live availability of NAISI services and the maintenance notice log.",
};

export default function StatusRoute() {
  return <StatusPage />;
}
