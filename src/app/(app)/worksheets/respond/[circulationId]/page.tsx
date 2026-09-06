"use client";

import { useParams } from "next/navigation";
import RespondPage from "@/features/worksheets/respond/RespondPage";

/**
 * /worksheets/respond/{circulationId}: the recipient's view of one send.
 *
 * OUTSIDE THE (author) GROUP ON PURPOSE. The library and the editor sit behind
 * a committee gate in that group's layout; a recipient need not be one. The
 * only gate here is the authed shell, and then the Firestore rules: reading
 * this circulation requires a response document at `responses/{your uid}`, so
 * somebody who was not sent this worksheet gets a refusal on the read and the
 * page's not-found state. See the module comment on RespondPage.
 *
 * A client page, so the param comes from `useParams` rather than the awaited
 * `params` promise a server page gets in Next 16.
 */
export default function WorksheetRespondRoute() {
  const params = useParams<{ circulationId: string }>();
  const circulationId =
    typeof params?.circulationId === "string" ? params.circulationId : null;

  if (!circulationId) return null;

  return <RespondPage circulationId={circulationId} />;
}
