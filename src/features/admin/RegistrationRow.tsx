"use client";

import { useState } from "react";
import Badge from "@/components/ui/Badge";
import {
  REGISTRATION_METHOD_META,
  REGISTRATION_STATUS_META,
  type RegistrationView,
} from "@/lib/firestore/registrations";
import styles from "./Registrations.module.css";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A single registration row in the admin tracker, with a two-step confirm delete. */
export default function RegistrationRow({
  reg,
  onDelete,
  busy = false,
}: {
  reg: RegistrationView;
  onDelete: () => void | Promise<void>;
  busy?: boolean;
}) {
  const meta = REGISTRATION_STATUS_META[reg.status];
  const methodMeta = REGISTRATION_METHOD_META[reg.method];
  const [confirming, setConfirming] = useState(false);

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.email}>{reg.email || "(no email)"}</span>
        <span className={styles.sub}>
          {methodMeta.label} · {reg.audience === "collaborator" ? "Collaborator" : "Member"}{" "}
          · created {formatDate(reg.createdAt)}
          {reg.sendCount > 1 ? ` · ${reg.sendCount} link sends` : ""}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Badge tone={methodMeta.tone}>{methodMeta.label}</Badge>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {confirming ? (
          <span className={styles.confirm}>
            Delete account?{" "}
            <button
              type="button"
              className={styles.confirmYes}
              onClick={() => void onDelete()}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Yes"}
            </button>{" "}
            <button
              type="button"
              className={styles.confirmNo}
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={() => setConfirming(true)}
            title="Delete this account (Auth, registration row, subscriptions)"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
