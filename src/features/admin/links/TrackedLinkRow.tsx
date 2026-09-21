"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { dayColumns, hourColumns, type LinkStats } from "@/lib/campaign/linkStats";
import { isPrintedSlug } from "@/lib/campaign/printedLinks";
import { scanBucket } from "@/lib/campaign/scanBuckets";
import { parseDestination, type TrackedLinkDoc } from "@/lib/firestore/trackedLinks";
import { ScanColumns } from "./ScanColumns";
import { TrackedLinkForm } from "./TrackedLinkForm";
import type { TrackedLinkInput } from "./trackedLinkMutations";
import styles from "./links.module.css";

type Props = {
  link: TrackedLinkDoc;
  campaigns: string[];
  origin: string;
  /** This link's numbers for the chosen range. */
  stats: LinkStats;
  /** The most scans any link on the page has, which every bar is drawn against. */
  maxScans: number;
  /** First day of the range, or null for all time. */
  fromDate: string | null;
  onSave: (slug: string, input: TrackedLinkInput) => Promise<void>;
};

export function TrackedLinkRow({ link, campaigns, origin, stats, maxScans, fromDate, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const address = `${new URL(origin).host}/q/${link.slug}`;
  const parsed = parseDestination(link.destination, [origin]);
  const counted = parsed.ok && (parsed.kind === "internal" || link.countOffsite);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${origin}/q/${link.slug}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard permission: the address is on screen to be selected.
    }
  }

  return (
    <Card padding="md">
      <div className={styles.row}>
        <div className={styles.rowBody}>
          <h3 className={styles.rowTitle}>{link.label || link.slug}</h3>
          <div className={styles.rowMeta}>
            <span className={styles.address}>{address}</span>
            <Badge tone={link.type === "qr" ? "accent" : "neutral"}>
              {link.type === "qr" ? "QR code" : "Link"}
            </Badge>
            {isPrintedSlug(link.slug) && <Badge tone="warning">On paper</Badge>}
            {!counted && <Badge tone="neutral">Not counted</Badge>}
          </div>
          <p className={styles.destination}>
            {link.active ? "Goes to " : "Switched off. Was going to "}
            <span className={styles.destinationValue}>{link.destination}</span>
          </p>
          {counted ? (
            <div className={styles.stats}>
              <span
                className={styles.track}
                role="img"
                aria-label={`${stats.scans} ${stats.scans === 1 ? "scan" : "scans"}`}
              >
                <span
                  className={styles.fill}
                  style={{ width: `${maxScans > 0 ? (stats.scans / maxScans) * 100 : 0}%` }}
                />
              </span>
              <span className={styles.figures}>
                <strong>{stats.scans}</strong> {stats.scans === 1 ? "scan" : "scans"}
                <span className={styles.figureGap}>·</span>
                <strong>{stats.signupsStarted}</strong> signed up
                <span className={styles.figureGap}>·</span>
                <strong>{stats.signupsConfirmed}</strong> confirmed
              </span>
            </div>
          ) : (
            <p className={styles.uncounted}>
              Goes straight to another site, so scans are not counted. Sign-ups cannot be traced
              to it either, because there is no page of ours in between.
            </p>
          )}
          {link.active && !parsed.ok && (
            <p className={styles.error}>
              This address is not one the site will follow ({parsed.error.replace(/\.$/, "")}), so the
              link is landing on the links page. Edit it to fix that.
            </p>
          )}
        </div>
        <div className={styles.rowActions}>
          <span className={`${styles.state} ${link.active ? styles.stateLive : styles.stateOff}`}>
            {link.active ? "Live" : "Off"}
          </span>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          {stats.scans > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setDetailed((v) => !v)}>
              {detailed ? "Hide days" : "By day"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Edit"}
          </Button>
        </div>
      </div>

      {detailed && stats.scans > 0 && (
        <div className={styles.details}>
          <ScanColumns
            caption="Scans by day"
            columns={dayColumns(stats.byDay, fromDate, scanBucket(new Date()).date)}
          />
          <ScanColumns caption="Scans by hour of the day, London time" columns={hourColumns(stats.byHour)} />
        </div>
      )}

      {editing && (
        <div className={styles.editor}>
          <TrackedLinkForm
            link={link}
            campaigns={campaigns}
            origin={origin}
            onSubmit={async (slug, input) => {
              await onSave(slug, input);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </Card>
  );
}
