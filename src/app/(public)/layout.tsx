import PublicHeader from "@/layout/PublicHeader";
import PublicFooter from "@/layout/PublicFooter";
import PublicMain, { PublicTransitionProvider } from "@/layout/PublicMain";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <PublicTransitionProvider>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <PublicHeader />
        <PublicMain>{children}</PublicMain>
        <PublicFooter />
      </div>
    </PublicTransitionProvider>
  );
}
