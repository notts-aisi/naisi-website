"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { AdminPage, AdminLoadingBar, AdminListFooter } from "@/features/admin/adminList";
import { TrackedLinkForm } from "@/features/admin/links/TrackedLinkForm";
import { TrackedLinkRow } from "@/features/admin/links/TrackedLinkRow";
import {
  createTrackedLink,
  ensurePrintedLinks,
  updateTrackedLink,
} from "@/features/admin/links/trackedLinkMutations";
import { useTrackedLinks } from "@/features/admin/links/useTrackedLinks";
import styles from "@/features/admin/links/links.module.css";
import { useHydrated } from "@/hooks/useHydrated";
import type { TrackedLinkDoc } from "@/lib/firestore/trackedLinks";

const NO_CAMPAIGN = "No campaign";

/**
 * Short links: every `naisi.uk/q/<slug>`, what it is and where it goes.
 *
 * Under `(admin-only)`, so `requireAdminPage()` in that group's layout is the
 * gate and this page writes none of its own. Reads and writes go client-direct
 * under the admin-only `trackedLinks` rule, as the Sources tab does.
 *
 * On load it creates a record for any printed code that does not have one
 * (`ensurePrintedLinks`), so the codes that are already on paper are always
 * here to be repointed and nobody has to remember a seeding step.
 */
export default function LinksAdminPage() {
  const { links, loading, refreshing, error, reload } = useTrackedLinks();
  const [creating, setCreating] = useState(false);
  const [seeded, setSeeded] = useState<string[]>([]);
  const hydrated = useHydrated();
  const origin = hydrated ? window.location.origin : "https://naisi.uk";

  // Once per visit, after the first successful load.
  const ensured = useRef(false);
  useEffect(() => {
    if (loading || error || ensured.current) return;
    ensured.current = true;
    void ensurePrintedLinks(new Set(links.map((link) => link.slug)))
      .then((created) => {
        if (created.length === 0) return;
        setSeeded(created);
        reload();
      })
      .catch(() => {
        // The codes are answered from the printed list until this succeeds,
        // so a failure here costs nothing but the rows. Try again next visit.
        ensured.current = false;
      });
  }, [loading, error, links, reload]);

  const campaigns = useMemo(
    () => [...new Set(links.map((link) => link.campaign).filter(Boolean))].sort(),
    [links],
  );

  const groups = useMemo(() => {
    const byCampaign = new Map<string, TrackedLinkDoc[]>();
    for (const link of links) {
      const key = link.campaign || NO_CAMPAIGN;
      byCampaign.set(key, [...(byCampaign.get(key) ?? []), link]);
    }
    return [...byCampaign.entries()]
      .map(([name, rows]) => ({
        name,
        rows: rows.sort((a, b) => a.slug.localeCompare(b.slug)),
      }))
      .sort((a, b) =>
        a.name === NO_CAMPAIGN ? 1 : b.name === NO_CAMPAIGN ? -1 : a.name.localeCompare(b.name),
      );
  }, [links]);

  return (
    <AdminPage>
      <div className={styles.head}>
        <p className={styles.count}>
          {loading ? "Loading links…" : `${links.length} ${links.length === 1 ? "link" : "links"}`}
        </p>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New link"}
        </Button>
      </div>

      <p className={styles.intro}>
        Print or post the short address, never the place it goes. The address
        is permanent; where it goes is yours to change, here, at any time.
        A change applies from the very next scan.
      </p>

      {seeded.length > 0 && (
        <Card padding="md">
          <p className={styles.count}>
            Added the codes that are already on paper: {seeded.join(", ")}. They
            were working before this and go to the same places now.
          </p>
        </Card>
      )}

      {creating && (
        <Card padding="lg">
          <TrackedLinkForm
            link={null}
            campaigns={campaigns}
            origin={origin}
            onSubmit={async (slug, input) => {
              await createTrackedLink(slug, input);
              setCreating(false);
              reload();
            }}
            onCancel={() => setCreating(false)}
          />
        </Card>
      )}

      {error && (
        <Card padding="md">
          <p className={styles.error}>Couldn&apos;t load: {error.message}</p>
        </Card>
      )}

      {loading && (
        <Card padding="md">
          <AdminLoadingBar label="Loading links…" />
        </Card>
      )}

      {groups.map((group) => (
        <section key={group.name} className={styles.group}>
          <h2 className={styles.groupHeading}>{group.name}</h2>
          <div className={styles.list}>
            {group.rows.map((link) => (
              <TrackedLinkRow
                key={link.slug}
                link={link}
                campaigns={campaigns}
                origin={origin}
                onSave={async (slug, input) => {
                  await updateTrackedLink(slug, input);
                  reload();
                }}
              />
            ))}
          </div>
        </section>
      ))}

      {!loading && !error && links.length > 0 && (
        <AdminListFooter
          shownCount={links.length}
          total={links.length}
          hasMore={false}
          onLoadMore={() => {}}
          onRefresh={reload}
          refreshing={refreshing}
          noun="links"
        />
      )}
    </AdminPage>
  );
}
