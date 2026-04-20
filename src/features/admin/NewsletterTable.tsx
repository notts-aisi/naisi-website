"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { downloadCSV, toCSV } from "@/lib/csv";
import { useNewsletterSubscribers, type Subscriber } from "./useNewsletterSubscribers";
import styles from "./NewsletterTable.module.css";

type EmailView = "preferred" | "gmail" | "uni";

function deliveryEmails(s: Subscriber, view: EmailView): string[] {
  const gmail = s.gmailEmail ?? "";
  const uni = s.universityEmail ?? "";
  if (view === "gmail") return gmail ? [gmail] : [];
  if (view === "uni") return uni ? [uni] : [];
  // "preferred": follow each user's delivery prefs, fall back to gmail.
  const out: string[] = [];
  if (s.deliverToGmail && gmail) out.push(gmail);
  if (s.deliverToUniEmail && uni) out.push(uni);
  if (out.length === 0 && gmail) out.push(gmail);
  return out;
}

function subscribersToCSV(rows: Subscriber[]): string {
  return toCSV(
    ["displayName", "role", "gmailEmail", "universityEmail", "deliverToGmail", "deliverToUniEmail"],
    rows.map((r) => [
      r.displayName,
      r.role,
      r.gmailEmail ?? "",
      r.universityEmail ?? "",
      r.deliverToGmail,
      r.deliverToUniEmail,
    ]),
  );
}

export default function NewsletterTable() {
  const { subs, loading, error } = useNewsletterSubscribers();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const counts = useMemo(() => {
    let gmail = 0;
    let uni = 0;
    for (const s of subs) {
      if (s.deliverToGmail && s.gmailEmail) gmail += 1;
      if (s.deliverToUniEmail && s.universityEmail) uni += 1;
    }
    return { gmail, uni };
  }, [subs]);

  async function copyAddresses(view: EmailView) {
    const emails = subs.flatMap((s) => deliveryEmails(s, view));
    const unique = Array.from(new Set(emails)).join(", ");
    if (!unique) {
      setCopyStatus("No addresses to copy for that view.");
      return;
    }
    try {
      await navigator.clipboard.writeText(unique);
      setCopyStatus(`Copied ${unique.split(", ").length} address(es).`);
    } catch (err) {
      console.error(err);
      setCopyStatus("Copy failed — browser blocked clipboard access.");
    }
    setTimeout(() => setCopyStatus(null), 3000);
  }

  function onDownload() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(`naisi-newsletter-${stamp}.csv`, subscribersToCSV(subs));
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading subscribers…</p>
      </Card>
    );
  }
  if (error) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t load subscribers: {error.message}
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <div className={styles.summary}>
        <div>
          <div className={styles.bigCount}>{subs.length}</div>
          <div className={styles.bigLabel}>
            Subscriber{subs.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className={styles.minis}>
          <div>
            <div className={styles.miniCount}>{counts.gmail}</div>
            <div className={styles.miniLabel}>Deliver to Gmail</div>
          </div>
          <div>
            <div className={styles.miniCount}>{counts.uni}</div>
            <div className={styles.miniLabel}>Deliver to uni email</div>
          </div>
        </div>
      </div>

      <Card padding="md">
        <div className={styles.actions}>
          <Button size="sm" onClick={() => copyAddresses("preferred")}>
            Copy (honour prefs)
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copyAddresses("gmail")}>
            Copy Gmail addresses
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copyAddresses("uni")}>
            Copy uni addresses
          </Button>
          <Button size="sm" variant="ghost" onClick={onDownload}>
            Download CSV
          </Button>
        </div>
        {copyStatus && (
          <p style={{ marginTop: "var(--space-3)", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {copyStatus}
          </p>
        )}
        <p style={{ marginTop: "var(--space-3)", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
          &ldquo;Honour prefs&rdquo; sends to each person&apos;s chosen inbox(es); if they haven&apos;t
          set a preference, falls back to their Gmail address.
        </p>
      </Card>

      {subs.length === 0 ? (
        <Card padding="md">
          <p style={{ color: "var(--color-text-muted)" }}>
            No subscribers yet. Registered users can opt in from their{" "}
            <a href="/profile" style={{ color: "var(--color-accent)", textDecoration: "underline" }}>
              profile
            </a>
            .
          </p>
        </Card>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Gmail</th>
                <th>University email</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.uid}>
                  <td>{s.displayName}</td>
                  <td>
                    <Badge tone="neutral">{s.role}</Badge>
                  </td>
                  <td>{s.gmailEmail ?? <span className={styles.muted}>—</span>}</td>
                  <td>{s.universityEmail ?? <span className={styles.muted}>—</span>}</td>
                  <td>
                    <div className={styles.deliveryCell}>
                      {s.deliverToGmail && <Badge tone="accent">Gmail</Badge>}
                      {s.deliverToUniEmail && <Badge tone="success">Uni</Badge>}
                      {!s.deliverToGmail && !s.deliverToUniEmail && (
                        <Badge tone="warning">No inbox set</Badge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
