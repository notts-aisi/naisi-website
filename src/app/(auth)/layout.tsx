import Link from "next/link";
import BrandMark from "@/components/BrandMark";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "var(--space-6)",
        background:
          "radial-gradient(ellipse at top, var(--color-accent-soft) 0%, transparent 55%), var(--color-bg)",
      }}
    >
      <header style={{ maxWidth: "var(--content-max-width)", margin: "0 auto", width: "100%" }}>
        <Link href="/" aria-label="NAISI home">
          <BrandMark size={32} />
        </Link>
      </header>
      <main
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          padding: "var(--space-10) 0",
        }}
      >
        {children}
      </main>
    </div>
  );
}
