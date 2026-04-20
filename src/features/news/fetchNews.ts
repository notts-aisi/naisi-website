import "server-only";
import { getAdminDb } from "@/lib/firebase/admin";

export type NewsArticle = {
  slug: string;
  title: string;
  tldr: string;
  bodyMarkdown: string;
  coverImageUrl?: string;
  publishedAt: string; // ISO string
  authorName?: string;
};

function normalize(id: string, data: FirebaseFirestore.DocumentData): NewsArticle {
  const published = data.publishedAt?.toDate?.() ?? data.publishedAt;
  return {
    slug: id,
    title: data.title ?? "Untitled",
    tldr: data.tldr ?? "",
    bodyMarkdown: data.bodyMarkdown ?? "",
    coverImageUrl: data.coverImageUrl,
    publishedAt: published instanceof Date ? published.toISOString() : String(published ?? ""),
    authorName: data.authorName,
  };
}

export async function listPublishedNews(): Promise<NewsArticle[]> {
  const db = getAdminDb();
  if (!db) return [];

  const snap = await db
    .collection("news")
    .where("publishedAt", "!=", null)
    .orderBy("publishedAt", "desc")
    .limit(50)
    .get();

  return snap.docs.map((d) => normalize(d.id, d.data()));
}

export async function getNewsArticle(slug: string): Promise<NewsArticle | null> {
  const db = getAdminDb();
  if (!db) return null;

  const doc = await db.collection("news").doc(slug).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!data?.publishedAt) return null;
  return normalize(doc.id, data);
}
