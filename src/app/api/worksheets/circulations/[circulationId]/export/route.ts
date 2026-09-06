import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import { toCSV } from "@/lib/csv";
import { logExport } from "@/lib/firestore/dataExports";
import { slugify } from "@/lib/firestore/slugId";
import { toCsvRows, type CsvTable } from "@/features/worksheets/aggregate";
import { isAddressableId, isCirculationStaff, loadCirculation } from "@/lib/worksheets/access";
import { scanResponses } from "@/lib/worksheets/responseScan";

/**
 * Every response to one circulation, as a CSV.
 *
 * ## A POST, and the log is written FIRST
 *
 * Both halves are lifted deliberately from `admin/membership/export`, which
 * carries the long version of the reasoning; the short version, because it
 * applies here at least as hard:
 *
 *  - NO WRITE ON A GET. A browser prefetches a GET, a proxy retries one, and a
 *    link pasted into a chat is fetched by whatever unfurls it. An export
 *    writes an audit row, so it cannot be a GET;
 *  - the `dataExports` row is written BEFORE the file is handed over, and a
 *    failure to write it REFUSES the export. `logExport` throws rather than
 *    swallowing exactly so that is not optional.
 *
 * What leaves the platform here is stronger than a membership list: it is what
 * each named person actually WROTE, in their own words, on a worksheet they
 * were told was being reviewed by the people running it. Once that file is on
 * a laptop nothing can follow it, so the one control left is a durable record
 * of who took it, which circulation it covered and how many people were in it.
 *
 * To be exact about the order: the responses and the names ARE read first,
 * because `rowCount` belongs in the record and an estimate would make the log
 * worth less than it is. Those rows sit in memory and go nowhere. What the log
 * gates is the only step that hands them over, and nothing between the log
 * write and the response can fail open.
 *
 * ## Staff, and staff of THIS circulation
 *
 * `isCirculationStaff` is the same predicate the rules use (`staffUids`, plus
 * admins), so the file contains exactly what the person could already read on
 * the circulation page one recipient at a time. It does NOT require
 * `circulateWorksheet`: a reviewer named on a circulation is there to read the
 * answers, and refusing them the spreadsheet form of the thing they can
 * already read would just move the work into copy and paste, which no log
 * records at all.
 *
 * ## No email addresses
 *
 * Names come from the `users` documents through `displayNameOf`, which is the
 * repo-wide fallback chain and ends at "NAISI member", never at an address.
 * There is no email column, no university-email column and no option for one:
 * the owner did not ask for contact details, the file is answers rather than a
 * mailing list, and `toCsvRows` is handed names only, so there is nothing in
 * scope for one to be added from by accident.
 */

/** Uids per addressed name read. Well inside `getAll`'s own limits. */
const NAME_BATCH = 300;

/** Preferred name, then account name, then a neutral placeholder. Never an
 *  email. Mirrors `displayNameOf` in the recipients route and the course
 *  routes; the repo carries one copy per route tree by convention. */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/** Names for the uids in the file, in ADDRESSED reads. Never a query over the
 *  users collection: the uids come from response documents, and a query would
 *  be a way to ask that collection questions this route has no business
 *  asking. */
async function readNames(
  db: FirebaseFirestore.Firestore,
  uids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(uids.filter((uid) => uid !== ""))];
  for (let i = 0; i < distinct.length; i += NAME_BATCH) {
    const slice = distinct.slice(i, i + NAME_BATCH);
    if (slice.length === 0) continue;
    const snaps = await db.getAll(...slice.map((uid) => db.collection("users").doc(uid)));
    for (const snap of snaps) {
      if (!snap.exists) continue;
      out.set(snap.id, displayNameOf(snap.data() ?? {}));
    }
  }
  return out;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ circulationId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { circulationId } = await ctx.params;
  if (!isAddressableId(circulationId)) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }
  if (!isCirculationStaff(circulation, actor)) {
    return NextResponse.json(
      { error: "You can't export this circulation." },
      { status: 403 },
    );
  }

  let table: CsvTable;
  let filename: string;
  try {
    const responses = await scanResponses(db, circulationId);
    const names = await readNames(db, responses.map((response) => response.uid));
    table = toCsvRows(circulation, responses, names);
    // The title as it stands, plus the day it was taken: two exports of one
    // circulation a week apart are different files and must not overwrite each
    // other in somebody's downloads folder. `slugify` caps and cleans the
    // title, so a worksheet called "Q1/Q2 review" cannot put a path separator
    // in a filename.
    filename = `worksheet-${slugify(circulation.title)}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
  } catch (err) {
    console.error("[worksheets export] build failed", circulationId, err);
    return NextResponse.json({ error: "Could not build that export." }, { status: 500 });
  }

  // THE LOG, BEFORE THE BODY. A throw here is a refusal, not a warning.
  try {
    await logExport(db, {
      kind: "worksheet-responses",
      actorUid: actor.uid,
      actorName: actor.displayName ?? "",
      // The CIRCULATION, never the worksheet: a worksheet is a library
      // document that has been sent any number of times, and the file that
      // left the platform held one sending's answers.
      scope: { circulationId },
      rowCount: table.rows.length,
      filename,
    });
  } catch (err) {
    console.error("[worksheets export] log write failed", circulationId, err);
    return NextResponse.json(
      {
        error:
          "The export could not be recorded, so it was not produced. "
          + "Every download of what people wrote is logged. Try again shortly.",
      },
      { status: 503 },
    );
  }

  return new Response(toCSV(table.header, table.rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Never cached: it carries what named people wrote, and a cached copy is
      // a copy nobody logged.
      "Cache-Control": "no-store",
    },
  });
}
