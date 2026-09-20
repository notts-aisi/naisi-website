"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { isPrintedSlug } from "@/lib/campaign/printedLinks";
import { parseDestination, type TrackedLinkDoc } from "@/lib/firestore/trackedLinks";
import { TrackedLinkForm } from "./TrackedLinkForm";
import type { TrackedLinkInput } from "./trackedLinkMutations";
import styles from "./links.module.css";

type Props = {
  link: TrackedLinkDoc;
  campaigns: string[];
  origin: string;
  onSave: (slug: string, input: TrackedLinkInput) => Promise<void>;
};

export function TrackedLinkRow({ link, campaigns, origin, onSave }: Props) {
  const [editing, setEditing] = useState(false);
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
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Edit"}
          </Button>
        </div>
      </div>

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
