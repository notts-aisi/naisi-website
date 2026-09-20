import { notFound } from "next/navigation";
import SourceSheetEditor from "@/features/admin/sources/SourceSheetEditor";
import { SOURCE_SLUG_PATTERN } from "@/lib/firestore/sourceSheets";

export const dynamic = "force-dynamic";

/**
 * The editor for one source sheet.
 *
 * A Server Component that only resolves the slug: the editor below it is a
 * client component, because it reads and writes `sourceSheets` client-direct
 * under the admin-only rule. `requireAdminPage()` in the `(admin-only)`
 * group's layout is the gate; nothing here repeats it.
 *
 * `params` is a Promise in this version of Next and has to be awaited.
 */
export default async function SourceSheetAdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // A slug that cannot be a document id is not an entry that can exist, so it
  // is a 404 here rather than a client-side read that would be refused.
  if (!SOURCE_SLUG_PATTERN.test(slug)) notFound();

  return <SourceSheetEditor slug={slug} />;
}
