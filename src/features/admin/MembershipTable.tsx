"use client";

import { useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import ResponsiveSelect, {
  type ResponsiveSelectOption,
} from "@/components/ui/ResponsiveSelect";
import Switch from "@/components/ui/Switch";
import {
  MEMBERSHIP_TIER_LABELS,
  type MembershipTier,
} from "@/lib/firestore/memberships";
import TierControl from "./TierControl";
import {
  deriveCounts,
  filterMembershipRows,
  type MembershipListRow,
} from "./membershipList";
import styles from "./MembershipTable.module.css";

/**
 * Every account, joined to its membership for the period on show.
 *
 * ## Pending accounts are IN, and that is the point
 *
 * The admin Members list cannot show them: it is the roster. Somebody who
 * registered on Monday, paid the Students' Union on Tuesday and is still
 * waiting for approval on Wednesday is exactly who an admin comes here to
 * find, so pending and rejected accounts are rows like any other, with the
 * role as a column and a filter that can put them away rather than a filter
 * that hides them before anybody looks.
 *
 * ## The filtering is local, and honest about it
 *
 * The route pages accounts with a cursor and the console follows the cursor to
 * the end, so every row is here before the filter runs. That keeps the counts
 * and the search consistent with each other; the alternative, filtering
 * server-side, would have a search box that pages and a count that does not.
 *
 * ## Wide content scrolls inside itself
 *
 * The authed shell must never scroll horizontally, so the table has its own
 * `overflow-x: auto` container. Six columns of names and addresses do not fit
 * a phone and are not meant to.
 */

const TIER_FILTERS: ResponsiveSelectOption<MembershipTier | "all" | "untagged">[] = [
  { value: "all", label: "Every tier" },
  { value: "paid", label: "Paid" },
  { value: "comped", label: "Comped" },
  { value: "alumni", label: "Alumni" },
  { value: "staff", label: "Staff" },
  { value: "untagged", label: "Not recorded" },
];

export default function MembershipTable({
  rows,
  periodId,
  loading,
  truncated,
  onRowChanged,
}: {
  rows: MembershipListRow[];
  periodId: string;
  loading: boolean;
  truncated: boolean;
  onRowChanged: (uid: string, tier: MembershipTier | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<MembershipTier | "all" | "untagged">("all");
  const [onlyLapsed, setOnlyLapsed] = useState(false);
  // Named for the switch: it hides every account that is not approved, which
  // is `pending` AND `rejected`. "Include pending" said half of that.
  const [includeUnapproved, setIncludeUnapproved] = useState(true);

  const visible = useMemo(
    () => filterMembershipRows(rows, { query, tier, onlyLapsed, includeUnapproved }),
    [rows, query, tier, onlyLapsed, includeUnapproved],
  );
  const derived = useMemo(() => deriveCounts(rows), [rows]);

  return (
    <div className={styles.wrap}>
      <div className={styles.filters}>
        <label className={styles.field} htmlFor="membership-search">
          <span className={styles.fieldLabel}>Search</span>
          <Input
            id="membership-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or email"
          />
        </label>
        <label className={styles.field} htmlFor="membership-tier">
          <span className={styles.fieldLabel}>Tier</span>
          <ResponsiveSelect<MembershipTier | "all" | "untagged">
            id="membership-tier"
            value={tier}
            onChange={setTier}
            options={TIER_FILTERS}
            ariaLabel="Filter by tier"
          />
        </label>
        <div className={styles.toggles}>
          <Switch
            checked={onlyLapsed}
            onChange={setOnlyLapsed}
            label="Lapsed only"
            description="Recorded last period, not this one"
          />
          <Switch
            checked={includeUnapproved}
            onChange={setIncludeUnapproved}
            label="Include unapproved accounts"
            description="People waiting for approval, and people turned down"
          />
        </div>
      </div>

      <p className={styles.counts}>
        {visible.length} of {rows.length} accounts shown. {derived.untagged} with
        nothing recorded for this period, {derived.lapsed} lapsed since the period
        before it.
      </p>
      {truncated && (
        <p className={styles.warning}>
          There are more accounts than this page will load. The counts above
          describe what is loaded, not the whole society.
        </p>
      )}

      <div className={styles.tableScroll}>
        <div className={styles.table}>
          <div className={styles.headRow}>
            <span>Name</span>
            <span>Email</span>
            <span>University email</span>
            <span>Role</span>
            <span>Membership</span>
            <span>Recorded</span>
          </div>
          {loading && rows.length === 0 ? (
            <p className={styles.muted}>Loading accounts…</p>
          ) : visible.length === 0 ? (
            <p className={styles.muted}>No accounts match that.</p>
          ) : (
            visible.map((row) => (
              <Row
                key={row.uid}
                row={row}
                periodId={periodId}
                onChanged={(next) => onRowChanged(row.uid, next)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  periodId,
  onChanged,
}: {
  row: MembershipListRow;
  periodId: string;
  onChanged: (next: MembershipTier | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.row}>
      <div className={styles.cell}>
        {/* A display name is member-authored text and is rendered as a text
            node, never as markup. */}
        <span className={styles.name}>{row.displayName || "No name"}</span>
        {row.preferredName && row.preferredName !== row.displayName && (
          <span className={styles.sub}>Goes by {row.preferredName}</span>
        )}
      </div>
      <span className={styles.cellText}>{row.email || "none"}</span>
      <span className={styles.cellText}>
        {row.universityEmail || "none"}
        {row.universityEmail && !row.uniEmailVerified && (
          <span className={styles.sub}>not verified</span>
        )}
      </span>
      <span className={styles.cellText}>{row.role}</span>
      <div className={styles.cell}>
        {row.tier ? (
          <Badge tone={row.tier === "alumni" ? "neutral" : "success"}>
            {MEMBERSHIP_TIER_LABELS[row.tier]}
          </Badge>
        ) : row.lapsed ? (
          <Badge tone="warning" title="Recorded for the period before this one">
            Lapsed
          </Badge>
        ) : (
          <Badge tone="neutral">Not recorded</Badge>
        )}
      </div>
      <div className={styles.cell}>
        <span className={styles.cellText} title={provenanceTitle(row)}>
          {provenanceLine(row)}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Change"}
        </Button>
        {open && (
          <TierControl
            uid={row.uid}
            periodId={periodId}
            tier={row.tier}
            onChanged={(next) => {
              onChanged(next);
              setOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The short line under the membership: where it came from and when. */
function provenanceLine(row: MembershipListRow): string {
  if (!row.tier) return "";
  const when = row.recordedAt ? new Date(row.recordedAt).toLocaleDateString("en-GB") : "";
  const how = row.source === "su-import" ? "SU import" : "recorded by hand";
  return when ? `${how}, ${when}` : how;
}

/**
 * The full provenance, on hover and as the accessible name of the same text.
 * `matchedOn` is the part that matters when a record is questioned: a name
 * match somebody confirmed is a different kind of fact from a verified
 * university email.
 */
function provenanceTitle(row: MembershipListRow): string {
  if (!row.tier) return "";
  const parts = [
    `Tier: ${MEMBERSHIP_TIER_LABELS[row.tier]}`,
    `Source: ${row.source === "su-import" ? "SU import" : "manual grant"}`,
    `Matched on: ${matchedOnWords(row.matchedOn)}`,
    row.recordedAt ? `Recorded: ${new Date(row.recordedAt).toLocaleString("en-GB")}` : "",
    `Recorded by: ${row.recordedByName || "not known"}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function matchedOnWords(matchedOn: MembershipListRow["matchedOn"]): string {
  if (matchedOn === "uni-email") return "their verified university email";
  if (matchedOn === "personal-email") return "their sign-in email";
  if (matchedOn === "name-confirmed") return "their name, confirmed by a person";
  if (matchedOn === "manual") return "an admin recording it by hand";
  return "not known";
}
