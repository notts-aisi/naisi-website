import ErrorPanel from "@/components/ErrorPanel";

/**
 * Root 404. Covers any URL that matches no route at all, including the three trees that sit outside a route group: /verify-email/[tokenId], /re-consent and /collaborator.
 *
 * Before this file, an unmatched URL shipped Next's stock white 404 page, which is jarring on a site that is black everywhere else. Note this one renders inside the root layout but outside every group layout, so it has no header and no nav; the group-level files below cover the common cases with proper chrome.
 */
export default function NotFound() {
  return (
    <ErrorPanel
      title="Page not found"
      description="That link does not point anywhere on this site. It may have been mistyped, or the page may have moved."
      homeHref="/"
      homeLabel="Go to the homepage"
    />
  );
}
