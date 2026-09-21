"use client";

import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import SegmentedControl from "@/components/ui/SegmentedControl";
import Switch from "@/components/ui/Switch";
import { isPrintedSlug } from "@/lib/campaign/printedLinks";
import {
  TRACKED_LINK_LIMITS,
  TRACKED_LINK_TYPES,
  parseDestination,
  type TrackedLinkDoc,
} from "@/lib/firestore/trackedLinks";
import type { TrackedLinkInput } from "./trackedLinkMutations";
import styles from "./links.module.css";

type Props = {
  /** The link being edited, or null when creating one. */
  link: TrackedLinkDoc | null;
  /** Campaign names already in use, offered as suggestions. */
  campaigns: string[];
  /** `https://naisi.uk`, or wherever this console is open. */
  origin: string;
  onSubmit: (slug: string, input: TrackedLinkInput) => Promise<void>;
  onCancel: () => void;
};

/**
 * Create and edit share this form. The one difference is the slug: it can be
 * typed when creating and is fixed for good afterwards, because it is the part
 * that gets printed.
 */
export function TrackedLinkForm({ link, campaigns, origin, onSubmit, onCancel }: Props) {
  const listId = useId();
  const [slug, setSlug] = useState(link?.slug ?? "");
  const [label, setLabel] = useState(link?.label ?? "");
  const [type, setType] = useState(link?.type ?? "qr");
  const [campaign, setCampaign] = useState(link?.campaign ?? "");
  const [destination, setDestination] = useState(link?.destination ?? "/links");
  const [active, setActive] = useState(link?.active ?? true);
  const [countOffsite, setCountOffsite] = useState(link?.countOffsite ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read live, so the form can say what will happen before anything is saved.
  const parsed = parseDestination(destination, [origin]);
  const offsite = parsed.ok && parsed.kind === "external";
  const printed = link ? isPrintedSlug(link.slug) : false;
  const host = new URL(origin).host;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(slug.trim().toLowerCase(), {
        label,
        destination,
        type,
        campaign,
        active,
        countOffsite,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the link.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.formGrid}>
        {!link && (
          <label className={styles.field}>
            <span className={styles.label}>Short name</span>
            <Input
              value={slug}
              maxLength={TRACKED_LINK_LIMITS.slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="flyer"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.label}>What it is</span>
          <Input
            value={label}
            maxLength={TRACKED_LINK_LIMITS.label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="A5 flyer, Portland Building noticeboards"
          />
        </label>
      </div>

      {!link && (
        <p className={styles.hint}>
          The address will be{" "}
          <strong>
            {host}/q/{slug || "…"}
          </strong>
          . Once it is printed or posted it cannot be changed, so choose it
          before the artwork is final. Lowercase letters, numbers and hyphens,
          and the shorter it is the easier the QR code is to scan. Where it
          goes can be changed at any time.
        </p>
      )}

      <div className={styles.formGrid}>
        <div className={styles.field}>
          <span className={styles.label}>Kind</span>
          <SegmentedControl
            value={type}
            onChange={setType}
            options={TRACKED_LINK_TYPES}
            ariaLabel="Kind of link"
          />
        </div>
        <label className={styles.field}>
          <span className={styles.label}>Campaign</span>
          <Input
            value={campaign}
            maxLength={TRACKED_LINK_LIMITS.campaign}
            onChange={(e) => setCampaign(e.target.value)}
            placeholder="Freshers 2026"
            list={listId}
          />
          <datalist id={listId}>
            {campaigns.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Where it goes</span>
        <Input
          value={destination}
          maxLength={TRACKED_LINK_LIMITS.destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="/links"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
      </label>
      <p className={parsed.ok ? styles.hint : styles.error}>
        {!parsed.ok
          ? parsed.error
          : offsite
            ? "Another site. Visits are not counted unless you turn counting on below."
            : "A page on this site. Every visit is counted, and a sign-up made there records this link."}
      </p>

      {offsite && (
        <Switch
          checked={countOffsite}
          onChange={setCountOffsite}
          label="Count visits to this site"
          description="Sends people through a brief page on naisi.uk that counts the visit and forwards them. Slightly slower, and a phone may open the website where a plain link would have opened the app. Leave off for Instagram unless the number matters more than that."
        />
      )}

      {link && (
        <Switch
          checked={active}
          onChange={setActive}
          label="Live"
          description={
            printed
              ? "This code is on printed material. Switched off, it lands on the links page: it never breaks, and it cannot be deleted."
              : "Switched off, the address lands on the links page. A link is never deleted, so the address can never be given to something else by mistake."
          }
        />
      )}

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.formActions}>
        <Button onClick={submit} disabled={busy || !parsed.ok}>
          {busy ? "Saving…" : link ? "Save" : "Create link"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
