"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { SU_PAGE_URL } from "@/content/socials";
import {
  MEMBERSHIP_TIER_LABELS,
  type MembershipMePayload,
} from "@/lib/firestore/memberships";
import styles from "./MembershipBadge.module.css";

/**
 * The member's own membership, on their profile.
 *
 * Reads `GET /api/membership/me` and nothing else. `memberships` is
 * `allow read, write: if false`, deliberately including the own-row read: a
 * `get` of a MISSING document evaluates `resource.data.uid` against null and
 * denies, so "you have no row" and "you may not look" would arrive here as the
 * same error and this card could not tell them apart. The route answers `null`
 * and means it.
 *
 * Website membership and SU membership are separate words, and the card says
 * so: an account on this site is not a society membership, and the link to buy
 * one is the SU's page rather than anything we can sell.
 */
export default function MembershipBadge() {
  const [data, setData] = useState<MembershipMePayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch("/api/membership/me")
      .then(async (res) => {
        if (!res.ok) throw new Error("unavailable");
        return (await res.json()) as MembershipMePayload;
      })
      .then((payload) => {
        if (live) setData(payload);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // Nothing to say yet, and nothing worth an error box either: a profile that
  // cannot reach this route is still a profile somebody is editing.
  if (failed || !data) return null;

  const { currentPeriod, membership, history } = data;
  const past = history.filter((row) => row.year !== currentPeriod?.year);

  return (
    <Card padding="lg">
      <div className={styles.head}>
        <h2 className={styles.heading}>Society membership</h2>
        {membership ? (
          <Badge tone="success">{MEMBERSHIP_TIER_LABELS[membership.tier]}</Badge>
        ) : (
          <Badge tone="neutral">Not recorded</Badge>
        )}
      </div>

      {!currentPeriod ? (
        <p className={styles.body}>
          We are not tracking a membership year at the moment.
        </p>
      ) : membership ? (
        <p className={styles.body}>
          You are recorded as a member for {currentPeriod.year}. Membership is a
          record we keep from the Students&apos; Union list; it does not change
          what you can do on this site.
        </p>
      ) : (
        <p className={styles.body}>
          We have no membership recorded for you for {currentPeriod.year}. An
          account here is not the same thing as society membership, which is
          bought through the Students&apos; Union:{" "}
          <a
            href={SU_PAGE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={styles.link}
          >
            join the society
          </a>
          . It can take us a week or two after you join to record it.
        </p>
      )}

      {past.length > 0 && (
        <p className={styles.history}>
          Previous years:{" "}
          {past.map((row) => `${row.year} (${MEMBERSHIP_TIER_LABELS[row.tier]})`).join(", ")}
        </p>
      )}
    </Card>
  );
}
