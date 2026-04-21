"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import styles from "./EmailPreview.module.css";

type Props = {
  subject: string;
  blocks: Block[];
  previewName?: string;
  /** Override the preview endpoint. Defaults to the newsletter preview. */
  endpoint?: string;
  /** Extra fields merged into the POST body (e.g. token map for app emails). */
  extraPayload?: Record<string, unknown>;
  /** Hint text under the "Live email preview" header. */
  hint?: string;
};

const DEBOUNCE_MS = 400;

/**
 * Fetches rendered HTML from the server (`/api/newsletter/preview` by default)
 * and displays it inside an iframe. Rendering is deliberately server-side —
 * putting @react-email/render in the client bundle made dev HMR unstable.
 */
export default function EmailPreview({
  subject,
  blocks,
  previewName = "Alex",
  endpoint = "/api/newsletter/preview",
  extraPayload,
  hint,
}: Props) {
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const extraKey = extraPayload ? JSON.stringify(extraPayload) : "";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject, blocks, previewName, ...extraPayload }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (!cancelled) setError(`Preview failed (${res.status}): ${text.slice(0, 200)}`);
          return;
        }
        const rendered = await res.text();
        if (!cancelled) {
          setHtml(rendered);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Preview error");
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [subject, blocks, previewName, endpoint, extraKey, extraPayload]);

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div>
          <strong>Live email preview</strong>
          <p className={styles.hint}>
            {hint ??
              "This is what a recipient sees. Personalisation tokens like `{preferredName}` show as the literal token here — they're replaced at send time with each recipient's name."}
          </p>
        </div>
      </div>
      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>
      )}
      <iframe
        srcDoc={html}
        title="Email preview"
        className={styles.frame}
        sandbox="allow-same-origin"
      />
    </div>
  );
}
