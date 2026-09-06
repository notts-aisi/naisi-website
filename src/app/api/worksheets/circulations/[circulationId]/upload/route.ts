import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  CIRCULATIONS_COLLECTION,
  isTerminalResponseState,
  normalizeResponse,
  RESPONSES_SUBCOLLECTION,
} from "@/lib/firestore/circulations";
import { questionsOf } from "@/lib/firestore/worksheets";
import { isAddressableId, loadCirculation } from "@/lib/worksheets/access";
import { sniffImageType } from "@/lib/worksheets/imageMagic";

/**
 * An image ANSWER: the bytes behind one `imageUpload` question.
 *
 * ── WHY THE BYTES COME THROUGH A ROUTE ──────────────────────────────────────
 * `storage.rules` refuses every client write to `worksheet-uploads/`, admins
 * and recipients included, because the one check that matters here is one a
 * storage rule cannot make. A rule sees the `Content-Type` the browser
 * declared, which is a claim about the file rather than a fact about it; this
 * route reads the first bytes and believes those instead. An SVG is a document
 * format that can carry script and these files are opened in a staff member's
 * browser tab, so "it says it is a PNG" is not good enough.
 *
 * ── WHAT THIS ROUTE DOES NOT DO: WRITE THE ANSWER ───────────────────────────
 * It returns `{ url, storagePath }` and stops. The answer itself is written by
 * the recipient's own autosave, client-direct, inside the `answers` band the
 * rules already police. That split is deliberate: the rules OWN the answers
 * (which is what makes "frozen once submitted" one rule rather than a rule and
 * a route that have to agree), and the route owns the bytes (which is what
 * makes the type check possible at all). A route that also wrote the answer
 * would be a second writer of a document the rules already govern, and the two
 * would eventually disagree about when a response is frozen.
 *
 * The consequence is honest and small: a file uploaded by somebody who then
 * closes the tab is an orphan blob under their own folder. It costs storage,
 * nothing references it, and the repo-wide cascade sweep already on the backlog
 * is where it gets collected.
 */

/** The same 5 MB `storage.rules` enforces on the images path beside this one. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * A filename safe to be the LAST segment of the storage path, and only that.
 *
 * The read rule matches `worksheet-uploads/{circulationId}/{uid}/{file}`
 * exactly, so a name carrying a slash would file the object at a path nobody
 * (including its uploader) can read. Leading dots go too: `..` as a name is a
 * traversal attempt in any consumer that resolves the path as a filesystem one.
 */
function safeFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
  return cleaned || "image";
}

/** A multipart part that carries bytes, without relying on `File` being global. */
function isUploadedFile(value: unknown): value is Blob {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).size === "number"
  );
}

export async function POST(
  req: Request,
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
  const storage = getAdminStorage();
  if (!db || !storage) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const circulation = await loadCirculation(db, circulationId);
  if (!circulation) {
    return NextResponse.json({ error: "Circulation not found" }, { status: 404 });
  }

  // OWN RESPONSE ONLY, addressed at the caller's own uid: there is no uid in
  // the request and no query, so this cannot be aimed at anybody else's folder.
  const responseSnap = await db
    .collection(CIRCULATIONS_COLLECTION)
    .doc(circulationId)
    .collection(RESPONSES_SUBCOLLECTION)
    .doc(actor.uid)
    .get();
  if (!responseSnap.exists) {
    return NextResponse.json(
      { error: "You haven't been sent this worksheet." },
      { status: 404 },
    );
  }
  const response = normalizeResponse(responseSnap.id, responseSnap.data() ?? {});

  // Frozen work takes no new bytes, and neither does a closed circulation. Both
  // are 409s: the caller is the right person, the moment has passed.
  if (isTerminalResponseState(response.state)) {
    return NextResponse.json(
      { error: "You've already submitted this, so it can't take another image." },
      { status: 409 },
    );
  }
  if (circulation.status !== "open") {
    return NextResponse.json(
      { error: "This worksheet has been closed." },
      { status: 409 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "That upload was malformed." }, { status: 400 });
  }

  const questionId = form.get("questionId");
  const question = questionsOf(circulation.items).find(
    (q) => typeof questionId === "string" && q.id === questionId,
  );
  if (!question || question.type !== "imageUpload") {
    return NextResponse.json(
      { error: "That question doesn't take an image." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!isUploadedFile(file)) {
    return NextResponse.json({ error: "No image was attached." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "That image is over the 5 MB limit." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Checked again against what actually arrived: `size` is what the part
  // declared, and the cap has to hold against the bytes that were really read.
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "That image is over the 5 MB limit." },
      { status: 400 },
    );
  }

  const declared = typeof (file as Blob).type === "string" ? (file as Blob).type : "";
  // Refused by NAME as well as by bytes. An SVG cannot pass the sniff below
  // either, so this is belt and braces, and the belt is worth having: the one
  // format that must never land here is the one somebody will eventually try to
  // wrap in a PNG header.
  if (declared === "image/svg+xml") {
    return NextResponse.json(
      { error: "SVG images aren't accepted here. Send a PNG, JPEG, GIF or WebP." },
      { status: 415 },
    );
  }
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return NextResponse.json(
      { error: "That file isn't a PNG, JPEG, GIF or WebP image." },
      { status: 415 },
    );
  }

  const storagePath = `worksheet-uploads/${circulationId}/${actor.uid}/${Date.now()}-${safeFileName(
    (file as File).name,
  )}`;
  // The token is what makes the returned URL work without a signed request:
  // Firebase's download endpoint accepts it, and the object stays otherwise
  // unreadable to anyone the storage rule refuses.
  const token = randomUUID();
  const bucket = storage.bucket();
  try {
    await bucket.file(storagePath).save(Buffer.from(bytes), {
      // The SNIFFED type, never the client's. The declared one is a claim and
      // this value decides what a browser will do with the response.
      contentType: sniffed,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
  } catch (err) {
    console.error("[worksheets upload] save failed", circulationId, actor.uid, err);
    return NextResponse.json({ error: "Couldn't save that image." }, { status: 500 });
  }

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
    storagePath,
  )}?alt=media&token=${token}`;
  return NextResponse.json({ url, storagePath });
}
