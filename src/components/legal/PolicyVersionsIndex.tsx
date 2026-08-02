import Link from "next/link";
import Badge from "@/components/ui/Badge";
import { POLICIES, type PolicyKey } from "@/lib/legal/policies";
import styles from "@/content/legal/legal.module.css";

/** Version-history index for a policy: every published version + its date. */
export default function PolicyVersionsIndex({ policy }: { policy: PolicyKey }) {
  const meta = POLICIES[policy];
  const current = meta.versions[0].version;

  return (
    <section className={styles.page}>
      <div className="container">
        <div className={styles.inner}>
          <Badge>Legal</Badge>
          <h1 className={styles.heading}>{meta.label} — version history</h1>
          <p className={styles.lede}>
            Every published version of our {meta.label}. The current version
            applies to your use of the site; earlier versions are kept for
            reference, so you can see exactly what you agreed to and when.
          </p>

          <ul className={styles.versionList}>
            {meta.versions.map((vrs) => (
              <li key={vrs.version}>
                <Link
                  href={vrs.version === current ? meta.href : `${meta.href}/v/${vrs.version}`}
                >
                  Version {vrs.version}
                </Link>
                <span className={styles.versionMeta}>
                  {vrs.lastUpdated}
                  {vrs.version === current ? " · current" : ""}
                </span>
              </li>
            ))}
          </ul>

          <p className={styles.meta}>
            <Link className={styles.metaLink} href={meta.href}>
              ← Back to the current {meta.label}
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
