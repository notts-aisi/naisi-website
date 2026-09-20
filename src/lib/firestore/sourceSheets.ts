import { validateSubmissionUrl } from "./courses";

/**
 * `sourceSheets/{slug}`: the bibliography behind one piece of printed or
 * posted material.
 *
 * A poster carries superscript numbers and a QR code; the numbered list of
 * what those superscripts refer to lives on `/sources/<slug>`. That makes two
 * fields in here irreversible in a way nothing else on the site is:
 *
 *  - THE NUMBER (`SourceItem.n`) is printed on paper. It is stored per row and
 *    minted from `nextNumber`, a counter that only ever grows, so deleting a
 *    row leaves a gap rather than shifting every later row onto the wrong
 *    citation. Never derive it from an array index, from `items.length + 1` or
 *    from `max(n) + 1`: the last two reuse a number the moment a row is
 *    deleted, and the reused number is already on the poster.
 *  - THE SLUG is the document id and the printed URL, so it is chosen once at
 *    creation and never edited afterwards.
 *
 * This module must NOT `import "server-only"`. Both the admin editor (a client
 * component writing client-direct) and the server-only public fetcher consume
 * it, and `tests/client-server-boundary.test.mjs` walks every `"use client"`
 * import graph looking for exactly that import.
 */

/**
 * Field budgets. Mirrored in `firestore.rules`, which is the boundary; these
 * are for `maxLength` attributes and inline errors, the same split
 * `FIELD_LIMITS` in users.ts records.
 *
 * `imageBytes` and `fileBytes` are mirrored into `storage.rules` instead, and
 * are checked in the browser before the upload starts so the person reads a
 * sentence rather than a raw Firebase permission string.
 */
export const SOURCE_SHEET_LIMITS = {
  slug: 80,
  title: 140,
  context: 140,
  summary: 400,
  itemName: 200,
  itemUrl: 500,
  itemComment: 500,
  maxItems: 200,
  /** The largest source number an admin may type. Keeps the counter sane. */
  maxNumber: 999,
  imageBytes: 10 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
} as const;

/** Lowercase letters, digits and hyphens. Printed under a QR code, so no case. */
export const SOURCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SourceItem = {
  /** Random and stable. Row identity for React keys and inline errors; NOT the
   *  printed number, which is `n`. */
  id: string;
  /** THE PRINTED NUMBER. Stored, minted, never derived from a position. */
  n: number;
  name: string;
  url: string;
  /**
   * An optional note about the source, shown on the public page beneath the
   * link when it has text. An empty one renders no element at all, and is
   * omitted from the stored object rather than written as `undefined`, which
   * Firestore refuses.
   */
  comment?: string;
};

export type SourceSheetImage = {
  url: string;
  storagePath: string;
  alt: string;
};

export type SourceSheetFile = {
  url: string;
  storagePath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type SourceSheetDoc = {
  /** The document id, the public URL and the string printed under the code. */
  slug: string;
  title: string;
  context: string;
  summary: string;
  image: SourceSheetImage | null;
  file: SourceSheetFile | null;
  items: SourceItem[];
  /** The mint counter. Only ever increases. */
  nextNumber: number;
  /** Presence IS published. Unpublishing deletes the field. */
  publishedAt: Date | null;
  /**
   * Set on the first publish and never cleared, including by unpublishing.
   * Unpublishing cannot un-print a poster, so this is what the editor reads
   * before warning that a number change breaks copies already in circulation.
   */
  firstPublishedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  createdByUid: string;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function normalizeImage(v: unknown): SourceSheetImage | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Raw;
  const url = str(raw.url, 2000);
  const storagePath = str(raw.storagePath, 500);
  if (!url || !storagePath) return null;
  return { url, storagePath, alt: str(raw.alt, 200) };
}

function normalizeFile(v: unknown): SourceSheetFile | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Raw;
  const url = str(raw.url, 2000);
  const storagePath = str(raw.storagePath, 500);
  if (!url || !storagePath) return null;
  return {
    url,
    storagePath,
    filename: str(raw.filename, 200) || "download.pdf",
    contentType: str(raw.contentType, 100) || "application/pdf",
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
  };
}

/**
 * One stored row.
 *
 * A row whose `n` is not a positive integer is dropped rather than repaired:
 * a repaired number is a wrong number that looks right, and the only honest
 * repair is an admin reading the poster. A gap in the numbering survives this
 * untouched, which is the property `tests/source-numbering.test.mjs` pins.
 */
function normalizeItem(v: unknown): SourceItem | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Raw;
  const n = raw.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
  const id = str(raw.id, 60);
  if (!id) return null;
  const comment = str(raw.comment, SOURCE_SHEET_LIMITS.itemComment).trim();
  const item: SourceItem = {
    id,
    n,
    name: str(raw.name, SOURCE_SHEET_LIMITS.itemName),
    url: str(raw.url, SOURCE_SHEET_LIMITS.itemUrl),
  };
  // Present only when it has text, in the stored shape and in the public
  // payload alike, so an empty note never reaches the page as an empty node.
  if (comment) item.comment = comment;
  return item;
}

export function normalizeSourceSheet(id: string, data: Raw): SourceSheetDoc {
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .slice(0, SOURCE_SHEET_LIMITS.maxItems)
    .map(normalizeItem)
    .filter((item): item is SourceItem => item !== null);

  const storedNext = typeof data.nextNumber === "number" ? data.nextNumber : 1;

  return {
    slug: id,
    title: str(data.title, SOURCE_SHEET_LIMITS.title) || "Untitled",
    context: str(data.context, SOURCE_SHEET_LIMITS.context),
    summary: str(data.summary, SOURCE_SHEET_LIMITS.summary),
    image: normalizeImage(data.image),
    file: normalizeFile(data.file),
    items,
    // Read back through the same floor a write applies, so a counter that was
    // somehow stored below the numbers already in use cannot mint a duplicate.
    nextNumber: advanceNextNumber(storedNext, items),
    publishedAt: tsToDate(data.publishedAt),
    firstPublishedAt: tsToDate(data.firstPublishedAt),
    createdAt: tsToDate(data.createdAt),
    updatedAt: tsToDate(data.updatedAt),
    createdByUid: str(data.createdByUid, 128),
  };
}

// ---------------------------------------------------------------------------
// Numbering. The pure half, unit-tested by tests/source-numbering.test.mjs.
// ---------------------------------------------------------------------------

/**
 * Where the counter has to sit for the next mint to be safe.
 *
 * Monotonic on purpose, in both arguments: it never goes below the counter it
 * was given, and never below one past the highest number in use. Deleting the
 * last row therefore leaves the counter where it was, which is the whole point
 * of storing a counter rather than measuring the list.
 */
export function advanceNextNumber(current: number, items: SourceItem[]): number {
  const floor = Number.isInteger(current) && current > 0 ? current : 1;
  let highest = 0;
  for (const item of items) if (item.n > highest) highest = item.n;
  return Math.max(floor, highest + 1);
}

/** A row id. Random, and never read as a number by anything. */
export function newSourceItemId(): string {
  return `src_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Append a blank row carrying the next minted number.
 *
 * Returns the new list AND the advanced counter together, because a caller
 * that took only the list would have to work the counter out again, and the
 * obvious way to do that (`max(n) + 1`) is the bug this whole module exists to
 * prevent.
 */
export function appendSourceItem(
  items: SourceItem[],
  nextNumber: number,
): { items: SourceItem[]; nextNumber: number } {
  const n = advanceNextNumber(nextNumber, items);
  const item: SourceItem = { id: newSourceItemId(), n, name: "", url: "" };
  return { items: [...items, item], nextNumber: n + 1 };
}

/**
 * Drop a row. The counter is deliberately NOT lowered: the deleted number is
 * printed somewhere and must never be handed to a different source.
 */
export function removeSourceItem(
  items: SourceItem[],
  id: string,
): SourceItem[] {
  return items.filter((item) => item.id !== id);
}

/**
 * Swap a row with its neighbour. Reordering changes the order rows are READ
 * in, never the number each row carries, so this touches `n` nowhere. Returns
 * the same array reference for an out-of-range move, the way the worksheet
 * editor's `moveItem` does, so the up arrow on the first row cannot dirty an
 * unsaved-changes flag.
 */
export function moveSourceItem(
  items: SourceItem[],
  index: number,
  direction: -1 | 1,
): SourceItem[] {
  const target = index + direction;
  if (index < 0 || index >= items.length) return items;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Replace one row, leaving every other row's identity untouched. */
export function updateSourceItem(
  items: SourceItem[],
  id: string,
  patch: Partial<Omit<SourceItem, "id">>,
): SourceItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SourceItemError = {
  /** The row's `id`, so the editor can put the message beside the right row. */
  id: string;
  field: "n" | "name" | "url";
  message: string;
};

/**
 * Every problem in the list, rather than the first one: an admin correcting a
 * bibliography wants the whole set of complaints in one pass.
 *
 * The duplicate check is the one that matters. Two rows sharing a number means
 * a superscript on the poster points at two different things, and no deploy
 * fixes a printed page.
 */
export function validateSourceItems(items: SourceItem[]): SourceItemError[] {
  const errors: SourceItemError[] = [];
  const seen = new Map<number, string>();

  for (const item of items) {
    if (!Number.isInteger(item.n) || item.n < 1 || item.n > SOURCE_SHEET_LIMITS.maxNumber) {
      errors.push({
        id: item.id,
        field: "n",
        message: `Give this source a number between 1 and ${SOURCE_SHEET_LIMITS.maxNumber}.`,
      });
    } else if (seen.has(item.n)) {
      errors.push({
        id: item.id,
        field: "n",
        message: `Number ${item.n} is already used in this entry. Each number appears once.`,
      });
    } else {
      seen.set(item.n, item.id);
    }

    if (!item.name.trim()) {
      errors.push({ id: item.id, field: "name", message: "Give the source a name." });
    } else if (item.name.length > SOURCE_SHEET_LIMITS.itemName) {
      errors.push({ id: item.id, field: "name", message: "That name is too long." });
    }

    const urlError = validateSubmissionUrl(item.url, SOURCE_SHEET_LIMITS.itemUrl);
    if (urlError) errors.push({ id: item.id, field: "url", message: urlError });
  }

  return errors;
}

/**
 * The link as the public page should treat it: a string when it passes the
 * same validator the editor applied on save, `null` when it does not.
 *
 * Re-applied at RENDER rather than trusted from the document, the way
 * `SessionCard` re-checks a facilitator's meeting link. A row stored before
 * this validator existed, or written straight into the console, must degrade
 * to plain text rather than putting a `javascript:` URL behind an anchor.
 */
export function renderableSourceUrl(url: string): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  return validateSubmissionUrl(trimmed, SOURCE_SHEET_LIMITS.itemUrl) ? null : trimmed;
}

/**
 * The host shown beside a source's name, so a reader can see where a link
 * goes before tapping it. `www.` is dropped because it is noise in that
 * position. Returns an empty string for anything that does not parse, and the
 * page renders nothing rather than a broken fragment.
 */
export function sourceHostname(url: string): string {
  const safe = renderableSourceUrl(url);
  if (!safe) return "";
  try {
    return new URL(safe).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Turn a title into a candidate slug. Only a suggestion: the admin can edit it
 * before creating the entry, and after that it is fixed for good.
 */
export function suggestSourceSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SOURCE_SHEET_LIMITS.slug)
    .replace(/-+$/g, "");
}

/** Null when the slug is usable as a document id and a printed URL. */
export function validateSourceSlug(slug: string): string | null {
  const trimmed = (slug ?? "").trim();
  if (!trimmed) return "Give this entry a short address for its page.";
  if (trimmed.length > SOURCE_SHEET_LIMITS.slug) return "That address is too long.";
  if (!SOURCE_SLUG_PATTERN.test(trimmed)) {
    return "Use lowercase letters, numbers and hyphens only, with no hyphen at either end.";
  }
  return null;
}
