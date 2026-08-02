import Link from "next/link";
import { notFound } from "next/navigation";
import { POLICIES, type PolicyKey } from "@/lib/legal/policies";
import { LEGAL_CONTENT } from "@/content/legal/registry";
import styles from "@/content/legal/legal.module.css";

/**
 * Renders a policy document — the current version, or a specific archived
 * version (`archived`) with a "view current" banner. The version's content
 * component is looked up from the registry; the meta line + banner are injected
 * into its slots so each version stays a frozen, self-contained module.
 */
export default function LegalPolicyPage({
  policy,
  version,
  archived = false,
}: {
  policy: PolicyKey;
  version?: number;
  archived?: boolean;
}) {
  const meta = POLICIES[policy];
  const v = version ?? meta.versions[0].version;
  const entry = meta.versions.find((x) => x.version === v);
  const Content = LEGAL_CONTENT[policy]?.[v];
  if (!entry || !Content) notFound();

  const metaNode = (
    <p className={styles.meta}>
      Last updated: {entry.lastUpdated} · Version {v} ·{" "}
      <Link className={styles.metaLink} href={`${meta.href}/versions`}>
        All versions
      </Link>
    </p>
  );

  const banner = archived ? (
    <div className={styles.archivedBanner}>
      You&apos;re viewing an archived version of this document (Version {v}).{" "}
      <Link href={meta.href}>View the current version</Link>.
    </div>
  ) : undefined;

  return <Content meta={metaNode} banner={banner} />;
}
