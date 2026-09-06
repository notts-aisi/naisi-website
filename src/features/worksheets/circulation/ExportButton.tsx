"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { slugify } from "@/lib/firestore/slugId";
import styles from "./CirculationActions.module.css";

/**
 * "Give me the spreadsheet": every response to this circulation, as a CSV.
 *
 * ── A POST, AND WHY THIS IS NOT A LINK ──────────────────────────────────────
 * The obvious shape for a download is an anchor at a GET, and it is the wrong
 * one here. The route writes a `dataExports` row BEFORE it hands over the
 * file, because what leaves the platform is what named people wrote in their
 * own words. A GET is prefetched by browsers, retried by proxies and fetched
 * by whatever unfurls a link somebody pastes into a chat, so a GET would write
 * audit rows for exports nobody asked for and make the log worthless. So: a
 * POST, the body arrives as a blob, and this creates the anchor itself.
 *
 * ── THE FILENAME COMES FROM THE SERVER WHERE IT CAN ─────────────────────────
 * `fetch` plus a blob does not honour `Content-Disposition` the way a
 * navigation does, so the name is read OUT of that header and used for the
 * download attribute. The locally-built fallback exists for the case where a
 * proxy has stripped the header, and it is built from the same two parts (the
 * slugged title and today's date) so a stripped header changes nothing a user
 * would notice. The server's name is preferred because the server's name is
 * the one written into the audit row: a file on a laptop can then be traced
 * back to the row that recorded it.
 */

type Props = {
  circulationId: string;
  /** Only for the fallback filename. The server names the real one. */
  title: string;
};

/** `attachment; filename="x.csv"` and the RFC 5987 form, if a proxy rewrote
 *  it. Anything else, and the caller falls back to its own name. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // A malformed percent-escape is not worth failing an export over.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

export default function ExportButton({ circulationId, title }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/worksheets/circulations/${encodeURIComponent(circulationId)}/export`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `That export did not run (${res.status}).`);
      }
      const filename =
        filenameFrom(res.headers.get("Content-Disposition")) ??
        `worksheet-${slugify(title)}-${new Date().toISOString().slice(0, 10)}.csv`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revoked after a beat so the download can finish in every browser.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That export did not run.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={styles.action}>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={busy}>
        {busy ? "Exporting…" : "Export CSV"}
      </Button>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
