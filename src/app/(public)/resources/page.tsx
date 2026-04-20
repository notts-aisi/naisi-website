import type { Metadata } from "next";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import resources from "@/content/resources.json";

export const metadata: Metadata = {
  title: "Resources",
  description:
    "Curated starting points for learning about AI safety — courses, research, governance, and careers.",
};

export default function ResourcesPage() {
  return (
    <section style={{ padding: "var(--space-16) 0" }}>
      <div className="container">
        <div style={{ maxWidth: "40rem", marginBottom: "var(--space-12)" }}>
          <Badge>Learn</Badge>
          <h1 style={{ marginTop: "var(--space-4)" }}>AI safety resources</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
            A curated list for anyone wanting to go deeper on AI safety. We keep this short on
            purpose — these are the things we&apos;d actually recommend.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-12)" }}>
          {resources.categories.map((cat) => (
            <div key={cat.title}>
              <h2 style={{ marginBottom: "var(--space-2)" }}>{cat.title}</h2>
              <p style={{ color: "var(--color-text-muted)", marginBottom: "var(--space-5)" }}>
                {cat.description}
              </p>
              <div
                style={{
                  display: "grid",
                  gap: "var(--space-4)",
                  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
                }}
              >
                {cat.items.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ textDecoration: "none", display: "block" }}
                  >
                    <Card padding="md" interactive>
                      <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-2)" }}>
                        {item.title}
                      </h3>
                      <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                        {item.description}
                      </p>
                    </Card>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
