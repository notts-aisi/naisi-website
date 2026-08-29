import ErrorPanel from "@/components/ErrorPanel";

/**
 * 404 for the signed-in app. Reached by the notFound() calls in the email-design and event-management detail routes, and by unmatched URLs inside the authed tree.
 *
 * Renders inside AppShell, so the sidebar stays available. Worth distinguishing from the public 404: in here a missing record usually means it was deleted or archived rather than that the URL is wrong.
 */
export default function NotFound() {
  return (
    <ErrorPanel
      title="Not found"
      description="That item does not exist, or you do not have access to it. It may have been deleted or archived."
      homeHref="/dashboard"
      homeLabel="Back to the dashboard"
    />
  );
}
