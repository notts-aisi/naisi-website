"use client";

import Link from "next/link";
import { AdminPage } from "@/features/admin/adminList";
import { LinksPageEditor } from "@/features/admin/links/LinksPageEditor";
import styles from "@/features/admin/links/links.module.css";

/**
 * The editor for what the public /links page says.
 *
 * Under `(admin-only)`, so `requireAdminPage()` in that group's layout is the
 * gate and this page writes none of its own. It reads and writes one document
 * client-direct under the admin-only `linksPage` rule.
 */
export default function LinksPageContentAdminPage() {
  return (
    <AdminPage>
      <div className={styles.head}>
        <Link href="/admin/links" className={styles.backLink}>
          Back to short links
        </Link>
        <a href="/links" target="_blank" rel="noopener noreferrer" className={styles.backLink}>
          Open /links in a new tab
        </a>
      </div>
      <LinksPageEditor />
    </AdminPage>
  );
}
