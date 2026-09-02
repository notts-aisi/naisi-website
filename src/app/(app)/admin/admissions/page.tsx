import RoundList from "@/features/admissions/RoundList";

/**
 * The admissions index. A thin server wrapper: unlike the other admin tabs the
 * reads here are ROUTE calls rather than client-direct Firestore, because
 * `admissionRounds` is `allow read, write: if false`, so the list route is the
 * boundary and this page has nothing to gate beyond its layout.
 */
export default function AdmissionsAdminPage() {
  return <RoundList />;
}
