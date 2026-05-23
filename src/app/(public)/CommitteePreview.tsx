import "server-only";
import Link from "next/link";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizeUser } from "@/lib/firestore/users";
import Reveal from "./Reveal";
import styles from "./CommitteePreview.module.css";

/*
  CommitteePreview — small grid of 4-6 committee avatars + names linking
  to /members. Dev-only until rolled out; gated by
  NEXT_PUBLIC_HOMEPAGE_PREVIEW_SECTIONS env var.
*/
export default async function CommitteePreview() {
  const dev = process.env.NEXT_PUBLIC_HOMEPAGE_PREVIEW_SECTIONS === "true";
  if (!dev) return null;

  const db = getAdminDb();
  if (!db) return null;

  let members: Array<{ id: string; name: string; title: string | null; photoURL: string | null }> = [];
  try {
    const snap = await db
      .collection("users")
      .where("role", "in", ["committee", "admin"])
      .limit(8)
      .get();
    members = snap.docs
      .map((d) => normalizeUser(d.id, d.data()))
      .filter((u) => u.showOnMembers !== false)
      .slice(0, 6)
      .map((u) => ({
        id: u.uid,
        name: u.profile?.preferredName || u.displayName || "Committee",
        title: u.title ?? null,
        photoURL: u.photoURL ?? null,
      }));
  } catch {
    return null;
  }

  if (members.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={`container ${styles.inner}`}>
        <header className={styles.head}>
          <Reveal variant="mask-wipe" as="h2" className={styles.heading}>
            Run by students.
          </Reveal>
          <p className={styles.blurb}>
            The committee meets weekly. <Link href="/members" className={styles.allLink}>See everyone →</Link>
          </p>
        </header>
        <Reveal variant="fade-rise" staggerChildren staggerMs={60} as="ul" className={styles.grid}>
          {members.map((m) => (
            <li key={m.id} className={styles.itemWrap}>
              <Link href="/members" className={styles.card}>
                <span className={styles.avatarWrap}>
                  {m.photoURL ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={m.photoURL} alt="" className={styles.avatar} loading="lazy" />
                  ) : (
                    <span className={styles.avatarFallback} aria-hidden>•</span>
                  )}
                </span>
                <span className={styles.name}>{m.name}</span>
                {m.title && <span className={styles.title}>{m.title}</span>}
              </Link>
            </li>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
