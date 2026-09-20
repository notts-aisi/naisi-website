/**
 * Whether the page that just loaded should count a scan, decided from its
 * query string alone.
 *
 * A scanned code lands on a page carrying `?q=<slug>`. The beacon counts that
 * once and then marks the address bar with `counted=1`, and a marked URL is
 * never counted again. The mark is what stops a phone that reloads a tab it
 * had put to sleep, which phones do constantly, from counting one person
 * twice. It also means a URL somebody copies out of the address bar and
 * shares is not counted as a scan when their friend opens it, which is right:
 * the friend did not scan anything.
 *
 * The mark lives in the URL and nowhere else. No cookie and no browser
 * storage is involved, so the closed lists in the privacy policy stay true.
 * `q` itself is left exactly as it was, because the subscribe form reads it at
 * the moment of submitting to say which code a sign-up came from.
 */
import { campaignSlugFromSearch } from "./attribution";

export const COUNTED_PARAM = "counted";

export type ScanToCount = {
  slug: string;
  /** The query string to leave in the address bar afterwards, with its `?`. */
  nextSearch: string;
};

export function scanToCount(search: string): ScanToCount | null {
  const params = new URLSearchParams(search);
  if (params.get(COUNTED_PARAM) === "1") return null;
  const slug = campaignSlugFromSearch(search);
  if (!slug) return null;
  params.set(COUNTED_PARAM, "1");
  return { slug, nextSearch: `?${params.toString()}` };
}
