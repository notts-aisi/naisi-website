import SubscriptionsTable from "@/features/admin/SubscriptionsTable";

export default function SubscriptionsAdminPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <p style={{ color: "var(--color-text-muted)", margin: 0 }}>
        Every subscription row in the junction collection: members and
        homepage guests, all channels. Confirmation status, audience type,
        and source are all visible here. Use the filters to scope the list,
        the CSV export to grab whatever&apos;s currently filtered.
      </p>
      <SubscriptionsTable />
    </div>
  );
}
