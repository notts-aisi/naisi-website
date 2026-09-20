"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import {
  AdminPage,
  AdminLoadingBar,
  AdminListFooter,
  useClientPagination,
} from "@/features/admin/adminList";
import { loadSourceSheet } from "@/features/admin/sources/sourceSheetData";
import { createSourceSheet } from "@/features/admin/sources/sourceSheetMutations";
import { useSourceSheets } from "@/features/admin/sources/useSourceSheets";
import styles from "@/features/admin/sources/sources.module.css";
import { formatSiteDate } from "@/lib/datetime/siteTime";
import {
  suggestSourceSlug,
  validateSourceSlug,
  SOURCE_SHEET_LIMITS,
} from "@/lib/firestore/sourceSheets";

/**
 * The library of source sheets: one entry per piece of produced material.
 *
 * Under `(admin-only)`, so `requireAdminPage()` in that group's layout is the
 * gate and this page writes none of its own. Reads and writes go client-direct
 * under the admin-only `sourceSheets` rule, exactly as the Projects tab does.
 */
export default function SourcesAdminPage() {
  const router = useRouter();
  const { sheets, loading, refreshing, error, reload } = useSourceSheets();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { shown, hasMore, loadMore, total, shownCount } = useClientPagination(sheets, 20);

  function onTitleChange(next: string) {
    setTitle(next);
    // The slug follows the title until the admin edits it by hand, and stops
    // following the moment they do. It is printed under a QR code, so it is
    // worth being able to set deliberately.
    if (!slugTouched) setSlug(suggestSourceSlug(next));
  }

  async function onCreate() {
    const cleanTitle = title.trim();
    const cleanSlug = slug.trim();
    if (!cleanTitle) {
      setFormError("Give this entry a title.");
      return;
    }
    const slugError = validateSourceSlug(cleanSlug);
    if (slugError) {
      setFormError(slugError);
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      // The slug is the document id, so creating on top of an existing one
      // would overwrite somebody else's entry, including a published one.
      const existing = await loadSourceSheet(cleanSlug);
      if (existing) {
        setFormError(`/sources/${cleanSlug} is already taken. Pick another address.`);
        return;
      }
      await createSourceSheet(cleanSlug, cleanTitle);
      router.push(`/admin/sources/${cleanSlug}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the entry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminPage>
      <div className={styles.head}>
        <p className={styles.count}>
          {loading
            ? "Loading source sheets…"
            : `${sheets.length} ${sheets.length === 1 ? "entry" : "entries"}`}
        </p>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New entry"}
        </Button>
      </div>

      {creating && (
        <Card padding="lg">
          <div className={styles.createGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Title</span>
              <Input
                value={title}
                maxLength={SOURCE_SHEET_LIMITS.title}
                onChange={(e) => onTitleChange(e.target.value)}
                placeholder="Freshers fair poster, September 2026"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Page address</span>
              <Input
                value={slug}
                maxLength={SOURCE_SHEET_LIMITS.slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="freshers-fair-2026"
              />
            </label>
          </div>
          <p className={styles.hint}>
            The page will be at <strong>naisi.uk/sources/{slug || "…"}</strong>.
            That address goes on the printed material, so it cannot be changed
            afterwards. Lowercase letters, numbers and hyphens.
          </p>
          {formError && <p className={styles.error}>{formError}</p>}
          <div className={styles.formActions}>
            <Button onClick={onCreate} disabled={busy}>
              {busy ? "Creating…" : "Create entry"}
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <Card padding="md">
          <p style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load: {error.message}
          </p>
        </Card>
      )}

      {loading && (
        <Card padding="md">
          <AdminLoadingBar label="Loading source sheets…" />
        </Card>
      )}

      {!loading && !error && sheets.length === 0 && !creating && (
        <Card padding="md">
          <p className={styles.count}>
            No source sheets yet. Create one for the next poster or carousel,
            publish it before the material goes to print, then put
            naisi.uk/sources/&lt;address&gt; behind the QR code.
          </p>
        </Card>
      )}

      <div className={styles.list}>
        {shown.map((sheet) => (
          <Link
            key={sheet.slug}
            href={`/admin/sources/${sheet.slug}`}
            className={styles.rowLink}
          >
            <Card padding="md" interactive>
              <div className={styles.row}>
                <div className={styles.rowBody}>
                  <h2 className={styles.rowTitle}>{sheet.title}</h2>
                  <div className={styles.rowMeta}>
                    <span className={styles.slug}>/sources/{sheet.slug}</span>
                    <span>
                      {sheet.items.length}{" "}
                      {sheet.items.length === 1 ? "source" : "sources"}
                    </span>
                    {sheet.file && <span>PDF</span>}
                    {sheet.updatedAt && (
                      <span>
                        Edited{" "}
                        {formatSiteDate(sheet.updatedAt, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    )}
                  </div>
                </div>
                <span
                  className={`${styles.state} ${
                    sheet.publishedAt ? styles.statePublished : styles.stateDraft
                  }`}
                >
                  {sheet.publishedAt ? "Published" : "Draft"}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      {!loading && !error && total > 0 && (
        <AdminListFooter
          shownCount={shownCount}
          total={total}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRefresh={reload}
          refreshing={refreshing}
          noun="entries"
        />
      )}
    </AdminPage>
  );
}
