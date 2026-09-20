"use client";

import { doc, runTransaction, serverTimestamp, updateDoc } from "firebase/firestore";
import { PRINTED_LINKS } from "@/lib/campaign/printedLinks";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  TRACKED_LINK_LIMITS,
  parseDestination,
  validateNewSlug,
  type TrackedLinkType,
} from "@/lib/firestore/trackedLinks";

/**
 * The admin console's writes to `trackedLinks`. Client-direct under an
 * admin-only rule, like the Sources and Projects tabs: the admin tree is closed
 * during a view-as session, so a write here is always the admin's own.
 *
 * There is no delete, here or in the rules. A link is switched off, never
 * removed, because a slug that has been printed has to stay accounted for.
 */

export type TrackedLinkInput = {
  label: string;
  destination: string;
  type: TrackedLinkType;
  campaign: string;
  active: boolean;
  countOffsite: boolean;
};

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

/**
 * The fields as they are stored. The destination goes through the same
 * validator the route runs on every scan, and what is stored is what that
 * validator returned: a full address pasted from this site becomes the path it
 * names, so the record means the same thing on the dev site and the live one.
 */
function storedFields(input: TrackedLinkInput) {
  const label = input.label.trim().slice(0, TRACKED_LINK_LIMITS.label);
  if (!label) throw new Error("Say what this link is, so it can be told apart later.");
  const parsed = parseDestination(input.destination, [window.location.origin]);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    label,
    destination: parsed.value,
    type: input.type,
    campaign: input.campaign.trim().slice(0, TRACKED_LINK_LIMITS.campaign),
    active: input.active,
    // Only meaningful for another site. A page on this one is always counted.
    countOffsite: parsed.kind === "external" && input.countOffsite,
  };
}

/**
 * Create a link. In a transaction, so it can only ever create: a slug that is
 * already taken is refused, never overwritten. Overwriting would silently
 * repoint somebody else's printed code.
 */
export async function createTrackedLink(slug: string, input: TrackedLinkInput): Promise<void> {
  const slugError = validateNewSlug(slug);
  if (slugError) throw new Error(slugError);
  const fields = storedFields(input);
  const uid = actingUid();
  const db = getClientDb();
  // Written out here, not behind a helper, so the client-query guard can read
  // which document the transaction's get addresses.
  const ref = doc(db, "trackedLinks", slug);
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists()) throw new Error(`naisi.uk/q/${slug} already exists. Pick another name.`);
    tx.set(ref, {
      slug,
      ...fields,
      createdByUid: uid,
      updatedByUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

/** Save an existing link. The slug, and who made it and when, never change. */
export async function updateTrackedLink(slug: string, input: TrackedLinkInput): Promise<void> {
  await updateDoc(doc(getClientDb(), "trackedLinks", slug), {
    ...storedFields(input),
    updatedByUid: actingUid(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Create a record for every printed code that does not have one yet, from the
 * list in `printedLinks.ts`. Returns the slugs it created.
 *
 * Run when the console loads, so the codes that are on paper are always there
 * to be repointed without anybody remembering a seeding step. Until it has
 * run, those codes are answered from the same list, so nothing depends on it
 * having run. Create-only, one transaction per slug: a record an admin has
 * already edited is never touched.
 */
export async function ensurePrintedLinks(existingSlugs: ReadonlySet<string>): Promise<string[]> {
  const missing = PRINTED_LINKS.filter((link) => !existingSlugs.has(link.slug));
  if (missing.length === 0) return [];
  const uid = actingUid();
  const db = getClientDb();
  const created: string[] = [];
  for (const link of missing) {
    const ref = doc(db, "trackedLinks", link.slug);
    const made = await runTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists()) return false;
      tx.set(ref, {
        slug: link.slug,
        label: link.label,
        destination: link.destination,
        type: link.type,
        campaign: link.campaign,
        active: true,
        countOffsite: false,
        createdByUid: uid,
        updatedByUid: uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return true;
    });
    if (made) created.push(link.slug);
  }
  return created;
}
