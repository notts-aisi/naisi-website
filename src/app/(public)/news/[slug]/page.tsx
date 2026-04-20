import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import Badge from "@/components/ui/Badge";
import { getNewsArticle } from "@/features/news/fetchNews";

type Props = { params: Promise<{ slug: string }> };

const loadArticle = cache(async (slug: string) => getNewsArticle(slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = await loadArticle(slug);
  if (!article) return { title: "Article not found" };

  return {
    title: article.title,
    description: article.tldr,
    openGraph: {
      title: article.title,
      description: article.tldr,
      type: "article",
      publishedTime: article.publishedAt,
      images: article.coverImageUrl ? [{ url: article.coverImageUrl }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description: article.tldr,
    },
  };
}

export const dynamic = "force-dynamic";

export default async function NewsArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await loadArticle(slug);
  if (!article) notFound();

  return (
    <article style={{ padding: "var(--space-16) 0" }}>
      <div className="container" style={{ maxWidth: "var(--prose-max-width)" }}>
        <Badge>News</Badge>
        <h1 style={{ marginTop: "var(--space-4)" }}>{article.title}</h1>
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            alignItems: "center",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            marginTop: "var(--space-3)",
            marginBottom: "var(--space-8)",
          }}
        >
          <time dateTime={article.publishedAt}>
            {new Date(article.publishedAt).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </time>
          {article.authorName && <span>· {article.authorName}</span>}
        </div>
        <p
          style={{
            fontSize: "var(--text-lg)",
            color: "var(--color-text)",
            lineHeight: "var(--leading-relaxed)",
            padding: "var(--space-5)",
            borderLeft: "3px solid var(--color-accent)",
            background: "var(--color-accent-soft)",
            borderRadius: "var(--radius-md)",
            marginBottom: "var(--space-8)",
          }}
        >
          {article.tldr}
        </p>
        <div className="prose" style={{ color: "var(--color-text)" }}>
          {/* v1: raw markdown rendered as plain text blocks. A markdown parser (react-markdown)
              can be added later without touching fetch or metadata code. */}
          {article.bodyMarkdown.split(/\n\n+/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      </div>
    </article>
  );
}
