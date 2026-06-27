"use client";

import Badge from "@/components/ui/Badge";
import {
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

/** A single registration row in the admin tracker list. */
export default function RegistrationRow({ reg }: { reg: RegistrationView }) {
  const meta = REGISTRATION_STATUS_META[reg.status];
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.email}>{reg.email || "(no email)"}</span>
        <span className={styles.sub}>
          {reg.audience === "collaborator" ? "Collaborator" : "Member"} · created{" "}
          {formatDate(reg.createdAt)}
          {reg.sendCount > 1 ? ` · ${reg.sendCount} link sends` : ""}
        </span>
      </div>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </div>
  );
}
