import SchedulerPanel from "@/features/admin/SchedulerPanel";
import SiteStatusPanel from "@/features/admin/SiteStatusPanel";

export default function SiteStatusAdminPage() {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "60rem",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-8)",
      }}
    >
      <SiteStatusPanel />
      {/* The scheduler answers the other half of "is the site healthy": the
          notice above says what visitors are being told, this says whether
          anything time-based is still going out. */}
      <SchedulerPanel />
    </div>
  );
}
