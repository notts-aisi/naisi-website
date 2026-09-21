"use client";

import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  defaultLinksPage,
  linksPageErrors,
  normalizeLinksPage,
  type LinksPageContent,
} from "@/lib/firestore/linksPage";

/**
 * The editor's read and write of `linksPage/main`. Client-direct under an
 * admin-only rule, like the rest of the admin console. The public /links page
 * never comes through here: it reads on the server (`fetchLinksPage`).
 *
 * The read owes its entry in
 * `scripts/rules-tests/tests/client-queries.registry.mjs`.
 */

export type LoadedLinksPage = {
  content: LinksPageContent;
  /** False when nothing has been saved yet and this is the built-in page. */
  stored: boolean;
};

export async function loadLinksPage(): Promise<LoadedLinksPage> {
  const snap = await getDoc(doc(getClientDb(), "linksPage", "main"));
  const stored = snap.exists() ? normalizeLinksPage(snap.data()) : null;
  return stored ? { content: stored, stored: true } : { content: defaultLinksPage(), stored: false };
}

/**
 * Save the whole page. Refused when any address would not be followed, so
 * what is stored is always something the public page can render in full.
 */
export async function saveLinksPage(content: LinksPageContent): Promise<void> {
  const errors = linksPageErrors(content);
  if (errors.length > 0) throw new Error(errors[0]);
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  await setDoc(doc(getClientDb(), "linksPage", "main"), {
    applications: content.applications,
    groups: content.groups,
    updatedByUid: uid,
    updatedAt: serverTimestamp(),
  });
}
