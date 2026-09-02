import ErrorPanel from "@/components/ErrorPanel";

/**
 * 404 for the public site. Reached by the notFound() calls in the news, events, courses, privacy and terms detail routes, and by unmatched URLs under those trees.
 *
 * The copy names courses because they are now the most likely way to land
 * here: a course page circulated before it is published, or a week URL guessed
 * from a neighbour, both 404 by design so a draft is indistinguishable from a
 * typo. Saying so turns a dead end into "it is not out yet".
 *
 * Renders inside the public layout, so it keeps the header and footer and the reader can navigate onward rather than being dumped somewhere chromeless.
 */
export default function NotFound() {
  return (
    <ErrorPanel
      title="Page not found"
      description="That page does not exist, or is not published yet. Courses, events and news items are only visible once they go live, and a course's weeks appear as they are published."
      homeHref="/"
      homeLabel="Go to the homepage"
    />
  );
}
