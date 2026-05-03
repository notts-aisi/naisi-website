import type { Metadata } from "next";
import Link from "next/link";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { listPublishedNews } from "@/features/news/fetchNews";

export const metadata: Metadata = {
  title: "News",
  description:
    "What actually moved in AI safety this week. The TL;DR, the things worth reading, and any opportunities you can act on.",
};

export const dynamic = "force-dynamic";

export default async function NewsIndex() {
  const articles = await listPublishedNews();

  return (
    <section style={{ padding: "var(--space-16) 0" }}>
      <div className="container">
        <div style={{ maxWidth: "40rem", marginBottom: "var(--space-10)" }}>
          <Badge>What&apos;s going on in AI/AIS</Badge>
          <h1 style={{ marginTop: "var(--space-4)" }}>News & digest</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
            Short, honest write-ups of the week&apos;s most important AI
            safety developments, and what they mean if you&apos;re thinking
            about the field.
          </p>
        </div>

        {articles.length === 0 ? (
          <Card padding="lg">
            <p style={{ color: "var(--color-text-muted)" }}>
              The first digest is on its way. Sign up and we&apos;ll let you know when it drops.
            </p>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {articles.map((a) => (
              <Link key={a.slug} href={`/news/${a.slug}`} style={{ textDecoration: "none" }}>
                <Card padding="lg" interactive>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--space-3)",
                      alignItems: "center",
                      color: "var(--color-text-muted)",
                      fontSize: "var(--text-sm)",
                      marginBottom: "var(--space-2)",
                    }}
                  >
                    <time dateTime={a.publishedAt}>
                      {new Date(a.publishedAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    </time>
                    {a.authorName && <span>· {a.authorName}</span>}
                  </div>
                  <h2 style={{ fontSize: "var(--text-2xl)", marginBottom: "var(--space-3)" }}>
                    {a.title}
                  </h2>
                  <p style={{ color: "var(--color-text-muted)" }}>{a.tldr}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
