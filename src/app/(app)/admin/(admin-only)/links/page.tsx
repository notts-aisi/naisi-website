"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { AdminPage, AdminLoadingBar, AdminListFooter } from "@/features/admin/adminList";
import { LinkStatsSummary } from "@/features/admin/links/LinkStatsSummary";
import { TrackedLinkForm } from "@/features/admin/links/TrackedLinkForm";
import { TrackedLinkRow } from "@/features/admin/links/TrackedLinkRow";
import {
  createTrackedLink,
  ensurePrintedLinks,
  updateTrackedLink,
} from "@/features/admin/links/trackedLinkMutations";
import { useLinkStats } from "@/features/admin/links/useLinkStats";
import { useTrackedLinks } from "@/features/admin/links/useTrackedLinks";
import styles from "@/features/admin/links/links.module.css";
import { useHydrated } from "@/hooks/useHydrated";
import { EMPTY_LINK_STATS, sumLinkStats } from "@/lib/campaign/linkStats";
import { downloadCSV, toCSV } from "@/lib/csv";
import { TRACKED_LINK_TYPES, type TrackedLinkDoc } from "@/lib/firestore/trackedLinks";

const NO_CAMPAIGN = "No campaign";

/** "QR codes" and "Links": the kinds, as the headings under a campaign. */
const KIND_HEADINGS = { qr: "QR codes", link: "Links" } as const;

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
 *
 * It is also the dashboard: grouped by campaign, split by kind, with each
 * link's scans and the sign-ups it produced for the chosen period. The two
 * exports are built in the browser and carry counts only, never an address, so
 * they are not files of named people and are not written to the exports log.
 */
export default function LinksAdminPage() {
  const { links, loading, refreshing, error, reload } = useTrackedLinks();
  const numbers = useLinkStats();
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

  const statsOf = (link: TrackedLinkDoc) => numbers.stats.get(link.slug) ?? EMPTY_LINK_STATS;

  // Campaign, then kind, then the busiest link first: the question the page
  // answers is which one worked.
  const groups = useMemo(() => {
    const byCampaign = new Map<string, TrackedLinkDoc[]>();
    for (const link of links) {
      const key = link.campaign || NO_CAMPAIGN;
      byCampaign.set(key, [...(byCampaign.get(key) ?? []), link]);
    }
    const scansOf = (link: TrackedLinkDoc) => numbers.stats.get(link.slug)?.scans ?? 0;
    return [...byCampaign.entries()]
      .map(([name, rows]) => ({
        name,
        totals: sumLinkStats(rows.map((link) => numbers.stats.get(link.slug) ?? EMPTY_LINK_STATS)),
        kinds: TRACKED_LINK_TYPES.map(({ value }) => {
          const ofKind = rows
            .filter((link) => link.type === value)
            .sort((a, b) => scansOf(b) - scansOf(a) || a.slug.localeCompare(b.slug));
          return {
            kind: value,
            rows: ofKind,
            totals: sumLinkStats(ofKind.map((link) => numbers.stats.get(link.slug) ?? EMPTY_LINK_STATS)),
          };
        }).filter((group) => group.rows.length > 0),
      }))
      .sort((a, b) =>
        a.name === NO_CAMPAIGN ? 1 : b.name === NO_CAMPAIGN ? -1 : a.name.localeCompare(b.name),
      );
  }, [links, numbers.stats]);

  const maxScans = Math.max(0, ...links.map((link) => statsOf(link).scans));
  const totals = sumLinkStats(links.map(statsOf));
  const byType = TRACKED_LINK_TYPES.map(({ value }) => ({
    label: KIND_HEADINGS[value],
    totals: sumLinkStats(links.filter((link) => link.type === value).map(statsOf)),
    any: links.some((link) => link.type === value),
  })).filter((kind) => kind.any);

  const periodLabel = numbers.range === "all" ? "all-time" : `last-${numbers.range}-days`;

  function exportTotals() {
    downloadCSV(
      `naisi-links-${periodLabel}.csv`,
      toCSV(
        ["campaign", "kind", "slug", "label", "destination", "live", "scans", "signed_up", "confirmed"],
        links.map((link) => {
          const stats = statsOf(link);
          return [
            link.campaign,
            link.type,
            link.slug,
            link.label,
            link.destination,
            link.active ? "yes" : "no",
            stats.scans,
            stats.signupsStarted,
            stats.signupsConfirmed,
          ];
        }),
      ),
    );
  }

  function exportDaily() {
    downloadCSV(
      `naisi-links-by-day-${periodLabel}.csv`,
      toCSV(
        ["date", "slug", "scans"],
        numbers.dailyRows.map((day) => [day.date, day.slug, day.count]),
      ),
    );
  }

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

      <LinkStatsSummary
        range={numbers.range}
        onRange={numbers.setRange}
        totals={totals}
        byType={byType}
        loading={numbers.loading}
        error={numbers.error}
        onExportTotals={exportTotals}
        onExportDaily={exportDaily}
      />

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
          <div className={styles.groupHead}>
            <h2 className={styles.groupHeading}>{group.name}</h2>
            <p className={styles.groupTotals}>
              <strong>{group.totals.scans}</strong> {group.totals.scans === 1 ? "scan" : "scans"}
              <span className={styles.figureGap}>·</span>
              <strong>{group.totals.signupsStarted}</strong> signed up
              <span className={styles.figureGap}>·</span>
              <strong>{group.totals.signupsConfirmed}</strong> confirmed
            </p>
          </div>
          {group.kinds.map((kind) => (
            <div key={kind.kind} className={styles.kind}>
              <h3 className={styles.kindHeading}>
                {KIND_HEADINGS[kind.kind]}
                <span className={styles.kindTotals}>
                  {kind.totals.scans} {kind.totals.scans === 1 ? "scan" : "scans"}
                </span>
              </h3>
              <div className={styles.list}>
                {kind.rows.map((link) => (
                  <TrackedLinkRow
                    key={link.slug}
                    link={link}
                    campaigns={campaigns}
                    origin={origin}
                    stats={statsOf(link)}
                    maxScans={maxScans}
                    fromDate={numbers.fromDate}
                    onSave={async (slug, input) => {
                      await updateTrackedLink(slug, input);
                      reload();
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}

      {!loading && !error && links.length > 0 && (
        <AdminListFooter
          shownCount={links.length}
          total={links.length}
          hasMore={false}
          onLoadMore={() => {}}
          onRefresh={() => {
            reload();
            numbers.reload();
          }}
          refreshing={refreshing}
          noun="links"
        />
      )}
    </AdminPage>
  );
}
