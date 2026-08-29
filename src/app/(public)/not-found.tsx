import ErrorPanel from "@/components/ErrorPanel";

/**
 * 404 for the public site. Reached by the notFound() calls in the news, events, courses, privacy and terms detail routes, and by unmatched URLs under those trees.
 *
 * Renders inside the public layout, so it keeps the header and footer and the reader can navigate onward rather than being dumped somewhere chromeless.
 */
export default function NotFound() {
  return (
    <ErrorPanel
      title="Page not found"
      description="That page does not exist, or is not published yet. Events and news items are only visible once they go live."
      homeHref="/"
      homeLabel="Go to the homepage"
    />
  );
}
