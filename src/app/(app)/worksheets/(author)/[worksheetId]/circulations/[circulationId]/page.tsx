"use client";

import { useParams } from "next/navigation";
import CirculationPage from "@/features/worksheets/circulation/CirculationPage";

/**
 * /worksheets/{worksheetId}/circulations/{circulationId}: the staff view of
 * one send.
 *
 * ROUTING IS THIS FILE'S WHOLE JOB. The route is nested under the worksheet so
 * the URL says where a circulation came from and the back link has somewhere
 * honest to point; who may read it is decided by the circulation's own
 * `staffUids`, by the Firestore rules and by `CirculationPage`, not by the
 * worksheet in the path.
 *
 * A client page, so the two params come from `useParams` rather than the
 * awaited `params` promise a server page gets in Next 16.
 */
export default function WorksheetCirculationPage() {
  const params = useParams<{ worksheetId: string; circulationId: string }>();
  const worksheetId = typeof params?.worksheetId === "string" ? params.worksheetId : null;
  const circulationId =
    typeof params?.circulationId === "string" ? params.circulationId : null;

  if (!worksheetId || !circulationId) return null;

  return <CirculationPage worksheetId={worksheetId} circulationId={circulationId} />;
}
