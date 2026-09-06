/**
 * The SU membership list, as it arrives: a batch document per upload and one
 * ROW DOCUMENT per line of the file.
 *
 * ## Rows live in a subcollection, and the commit reads them from there
 *
 * `membershipImports/{batchId}/rows/{NNNN}`, ids zero-padded so they sort in
 * file order without a stored index. Two reasons, and both are load-bearing:
 *
 *  - a real SU list is thousands of lines. Rows on the parent document would
 *    approach the 1MB document limit, so a file could be REPORTED on in full
 *    and only partly committable, which is the worst kind of half-working;
 *  - the commit route reads the rows it acts on FROM FIRESTORE, never from
 *    the request body. The name tier is confirm-only precisely because a name
 *    is weak evidence, and a commit that trusted a posted row would let the
 *    browser hand over any uid it liked with a name match already stamped on
 *    it. The body carries row IDS to confirm and nothing else.
 *
 * ## The three tiers of match, and why the third cannot auto-commit
 *
 * In order, per row:
 *
 *  1. the VERIFIED university email on an account (`profile.universityEmail`
 *     with `uniEmailVerifiedAt` set), case-folded. Somebody proved they own
 *     that address by clicking a link we sent to it, so this is the only
 *     match backed by evidence;
 *  2. the account's sign-in email, case-folded. Weaker: nobody proved it here,
 *     but Google did, and the SU list carries the address a person typed on a
 *     society form, so a hit is a person saying "this is me" twice;
 *  3. a normalised display name. NEVER auto-committed. Two students share a
 *     name often enough that the false positive is not hypothetical, and the
 *     cost of getting it wrong is recording that somebody paid when they did
 *     not, and telling somebody else they did not when they did. A name row
 *     commits only when its row id is in the commit call's `confirmedRowIds`,
 *     and the row then stamps WHO confirmed it.
 *
 * A name that matches two or more accounts is not a match at all: there is
 * nothing for a human to confirm except a coin toss, so it is reported
 * unmatched with the reason written out.
 *
 * ## Account deletion, and what happens to a batch
 *
 * A row NAMES A PERSON: the name and email on the SU list, and the uid it was
 * matched to. `deleteMembershipImportRows` sweeps rows by `matchedUid` when an
 * account is deleted, in the same cascade that deletes their membership rows.
 *
 * The RETENTION DECISION, stated here so a later reader does not have to infer
 * it from the code: BATCH DOCUMENTS ARE RETAINED, and rows that were never
 * matched to an account are retained with them. A batch is the provenance
 * behind every membership row it wrote ("this came from the SU list uploaded
 * on the 9th of October by Sam"), and deleting the batch would leave those
 * memberships claiming a source with nothing behind it. An unmatched row names
 * somebody who has no account here at all, so an account deletion is not their
 * deletion and cannot be treated as one: it is a line from a file the society
 * received, kept with the file. What goes is the row for the account being
 * deleted, because that row is about them and the membership it wrote is being
 * deleted in the same pass.
 *
 * ## Not in the courses destroy manifest, deliberately
 *
 * The course and run DESTROY cascades do not touch either collection and no
 * manifest entry is owed: an import is scoped to a MEMBERSHIP PERIOD, which is
 * a year of the society, not to a course, a run or a group. Destroying a run
 * has nothing to say about who paid their SU membership that year.
 */

import {
  isMembershipTier,
  type MembershipMatchedOn,
  type MembershipTier,
} from "./memberships";
import { slugId } from "./slugId";

export const MEMBERSHIP_IMPORTS_COLLECTION = "membershipImports";

/**
 * The rows subcollection. The collection-group name is short and generic, so
 * every collection-group read of it re-checks that the grandparent really is
 * `membershipImports` before acting on a document.
 */
export const MEMBERSHIP_IMPORT_ROWS_SUBCOLLECTION = "rows";

export const MEMBERSHIP_IMPORT_LIMITS = {
  /** The upload cap, in characters of CSV text. Roughly 10,000 SU rows. */
  maxCsvChars: 1_000_000,
  /** Rows persisted per batch. A file longer than this is refused whole,
   *  never truncated: a silently half-read list is how 500 people go missing. */
  maxRows: 5_000,
  /** People committed per commit call. The commit is resumable, so this is a
   *  request-length budget and not a limit on the size of a list. */
  commitChunk: 200,
  name: 120,
  email: 160,
  filename: 120,
} as const;

/**
 * writing: the batch document exists but its rows are still being written.
 * The dry run creates the batch FIRST in this state and flips it to `dry-run`
 * once every row has landed, so a crash halfway leaves a batch that the
 * unfinished list can show and Abandon can close, rather than up to five
 * thousand orphan rows under a parent document that nothing will ever list.
 * A `writing` batch is never committable: `totalRows` on it is a promise the
 * rows may not keep.
 * dry-run: uploaded and matched, nothing written to `memberships` yet.
 * committing: at least one chunk has been committed and work remains.
 * committed: every actionable row has been committed or skipped.
 * abandoned: an admin walked away from it, or closed a stuck `writing` batch.
 * The rows are kept: they are the record of what the file said.
 */
export type MembershipImportStatus =
  | "writing"
  | "dry-run"
  | "committing"
  | "committed"
  | "abandoned";

export const MEMBERSHIP_IMPORT_STATUSES: MembershipImportStatus[] = [
  "writing",
  "dry-run",
  "committing",
  "committed",
  "abandoned",
];

/**
 * Statuses an admin still has work to do on, which is what the console's
 * resume list asks for. `writing` is in it because a stuck one needs closing
 * by hand; `committed` and `abandoned` are done and stay out.
 */
export const MEMBERSHIP_IMPORT_UNFINISHED: MembershipImportStatus[] = [
  "writing",
  "dry-run",
  "committing",
];

export function isMembershipImportStatus(v: unknown): v is MembershipImportStatus {
  return (
    typeof v === "string"
    && MEMBERSHIP_IMPORT_STATUSES.includes(v as MembershipImportStatus)
  );
}

/**
 * How one line of the file resolved.
 *
 * `uni-email` and `personal-email` are committable without a human. `name` is
 * committable only with a per-row confirmation. `duplicate` is a second line
 * for a person an earlier line already claimed, in the SAME file. `none` is a
 * line with no account behind it, which on a real SU list is most of them:
 * plenty of society members never make a website account.
 */
export type MembershipImportMatchKind =
  | "uni-email"
  | "personal-email"
  | "name"
  | "duplicate"
  | "none";

/** The `matchedOn` a committed row records, or null when it cannot commit. */
export function matchedOnForKind(
  kind: MembershipImportMatchKind,
): MembershipMatchedOn | null {
  if (kind === "uni-email") return "uni-email";
  if (kind === "personal-email") return "personal-email";
  if (kind === "name") return "name-confirmed";
  return null;
}

/** Whether a kind may be committed with nobody looking at it. */
export function isAutoCommittable(kind: MembershipImportMatchKind): boolean {
  return kind === "uni-email" || kind === "personal-email";
}

export type MembershipImportRowState = "pending" | "committed" | "skipped";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * `import {periodId} {uploadedAt ISO minute}`, slugged.
 *
 * The minute rather than the millisecond so the id an admin reads in the
 * Firebase console says when the upload happened, and the random suffix
 * `slugId` adds is what keeps two uploads in the same minute apart.
 */
export function membershipImportBatchId(periodId: string, uploadedAt: Date): string {
  return slugId(`import ${periodId} ${isoMinute(uploadedAt)}`);
}

/** `2026-10-09T14:31`. Seconds and milliseconds dropped, `Z` dropped. */
export function isoMinute(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/**
 * Row ids are the 1-based sequence number, zero-padded to four digits, so a
 * plain document-id sort is file order and the commit can address the next
 * chunk without a query or an index.
 */
export function membershipImportRowId(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError(`row sequence must be a positive integer, got ${seq}`);
  }
  return String(seq).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// The CSV parser
// ---------------------------------------------------------------------------

export type ParsedCsv = { header: string[]; rows: string[][] };
export type CsvParseFailure = { error: string };

/**
 * A small strict RFC-4180 parser. `src/lib/csv.ts` only WRITES CSV, so this is
 * the reading half, and it lives here rather than there because it is used by
 * one server route and `csv.ts` is imported into the browser bundle.
 *
 * Strict about the two things that lose data silently:
 *
 *  - an unterminated quoted field is an error naming the line, not a field
 *    that swallows the rest of the file;
 *  - a line with MORE cells than the header is an error naming the line. That
 *    is what an unescaped comma in a name looks like, and guessing which cell
 *    to drop is how "Smith, Jr" becomes somebody else's email address.
 *
 * Forgiving about the two that do not: a line with FEWER cells is padded
 * (exporters trim trailing empties), and a wholly blank line is dropped.
 * A UTF-8 BOM is stripped, because Excel writes one.
 */
export function parseCsv(text: string): ParsedCsv | CsvParseFailure {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;

  const endField = () => {
    cells.push(field);
    field = "";
    touched = true;
  };
  const endRecord = () => {
    endField();
    const blank = cells.length === 1 && cells[0].trim() === "";
    if (!blank) records.push({ cells, line: recordLine });
    cells = [];
    touched = false;
    recordLine = line;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      touched = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      line += 1;
      endRecord();
      continue;
    }
    field += ch;
  }
  if (quoted) {
    return { error: `Line ${recordLine}: a quoted value is never closed.` };
  }
  if (field !== "" || touched || cells.length > 0) endRecord();

  if (records.length === 0) return { error: "That file has no rows in it." };
  const [head, ...rest] = records;
  const header = head.cells.map((c) => c.trim());
  const width = header.length;
  const rows: string[][] = [];
  for (const record of rest) {
    if (record.cells.length > width) {
      return {
        error:
          `Line ${record.line} has ${record.cells.length} values where the header has `
          + `${width}. A comma inside a name or address has to be quoted.`,
      };
    }
    const padded = [...record.cells];
    while (padded.length < width) padded.push("");
    rows.push(padded.map((c) => c.trim()));
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type ColumnMap = {
  name: number;
  firstName: number;
  lastName: number;
  email: number;
  uniEmail: number;
  tier: number;
};

const COLUMN_SYNONYMS: Record<keyof ColumnMap, string[]> = {
  name: ["name", "full name", "member name", "student name", "member"],
  firstName: ["first name", "firstname", "forename", "given name", "first"],
  lastName: ["last name", "lastname", "surname", "family name", "last"],
  email: ["email", "email address", "e-mail", "personal email", "contact email"],
  uniEmail: [
    "university email",
    "uni email",
    "student email",
    "institution email",
    "university email address",
    "nottingham email",
    "academic email",
  ],
  tier: ["tier", "membership type", "membership", "type", "product"],
};

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Which column is which, by header name.
 *
 * Longest synonym first so "university email" is not claimed by "email", and
 * the university-email column is resolved BEFORE the personal one so a file
 * with only a `student email` column cannot have it read as a sign-in address
 * and matched at the weaker tier.
 */
export function resolveColumns(header: string[]): ColumnMap | CsvParseFailure {
  const keys = header.map(headerKey);
  const taken = new Set<number>();
  const find = (field: keyof ColumnMap): number => {
    for (const synonym of COLUMN_SYNONYMS[field]) {
      const at = keys.indexOf(synonym);
      if (at !== -1 && !taken.has(at)) {
        taken.add(at);
        return at;
      }
    }
    return -1;
  };
  // Order matters: the most specific header wins its column first.
  const uniEmail = find("uniEmail");
  const email = find("email");
  const name = find("name");
  const firstName = find("firstName");
  const lastName = find("lastName");
  const tier = find("tier");

  if (uniEmail === -1 && email === -1 && name === -1 && firstName === -1) {
    return {
      error:
        "That file has no column this can match on. It needs at least one of: "
        + "university email, email, name, or first name and last name.",
    };
  }
  return { name, firstName, lastName, email, uniEmail, tier };
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

export function normaliseEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * A name reduced to what two spellings of the same person share: lowercase,
 * accents decomposed away, punctuation and honorifics gone, words sorted so
 * "Ada Lovelace" and "Lovelace, Ada" are one key.
 *
 * Sorting the words is what makes the surname-first form work, and it is also
 * why this key is CONFIRM-ONLY evidence: it deliberately throws information
 * away to catch more spellings, which is the same thing as saying it collides
 * more often.
 */
export function normaliseName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  const words = cleaned
    .split(" ")
    .filter((w) => w !== "" && !HONORIFICS.has(w));
  if (words.length === 0) return "";
  return [...words].sort().join(" ");
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof"]);

/** The tier a `membership type` cell names, or null when it names nothing. */
export function tierFromCell(cell: unknown): MembershipTier | null {
  const key = typeof cell === "string" ? cell.trim().toLowerCase() : "";
  if (key === "") return null;
  if (isMembershipTier(key)) return key;
  if (["standard", "full", "member", "full member", "annual"].includes(key)) return "paid";
  if (["comp", "bursary", "free", "concession", "hardship"].includes(key)) return "comped";
  if (["alumnus", "alumna", "graduate", "past member"].includes(key)) return "alumni";
  if (["staff member", "employee", "academic"].includes(key)) return "staff";
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** One account, reduced to the three things a row can be matched against. */
export type MatchableAccount = {
  uid: string;
  email: string;
  displayName: string;
  preferredName: string;
  /** Only ever the VERIFIED address. An unverified one is not evidence. */
  verifiedUniEmail: string;
};

export type MatchIndex = {
  byUniEmail: Map<string, string>;
  byEmail: Map<string, string>;
  /** Name key to every uid that answers to it. More than one is ambiguous. */
  byName: Map<string, string[]>;
};

/**
 * Build the lookup ONCE per import from one pass over `users`.
 *
 * `findVerifiedUniEmailOwner` is the shared case-folded lookup and it scans
 * the whole collection per call, which is right for a registration checking
 * one address and catastrophic for a 5,000 row import. This is the same
 * case-folding, done once, in the same order of preference.
 */
export function buildMatchIndex(accounts: readonly MatchableAccount[]): MatchIndex {
  const byUniEmail = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.uid) continue;
    const uni = normaliseEmail(account.verifiedUniEmail);
    if (uni && !byUniEmail.has(uni)) byUniEmail.set(uni, account.uid);
    const email = normaliseEmail(account.email);
    if (email && !byEmail.has(email)) byEmail.set(email, account.uid);
    for (const raw of [account.displayName, account.preferredName]) {
      const key = normaliseName(raw);
      if (!key) continue;
      const uids = byName.get(key) ?? [];
      if (!uids.includes(account.uid)) uids.push(account.uid);
      byName.set(key, uids);
    }
  }
  return { byUniEmail, byEmail, byName };
}

/** One line of the file, before it is matched. */
export type ImportCandidate = {
  line: number;
  name: string;
  email: string;
  uniEmail: string;
  tier: MembershipTier;
};

export type ImportMatch = {
  kind: MembershipImportMatchKind;
  uid: string | null;
  /** Why this row cannot commit, in words an admin can act on. */
  note: string;
};

/**
 * The three-tier match, for one row, against the index.
 *
 * Order is fixed and is the whole design: proven address, then sign-in
 * address, then name. A row whose name matches two accounts comes back
 * unmatched with the reason, because "pick one" is not a confirmation.
 */
export function matchCandidate(index: MatchIndex, row: ImportCandidate): ImportMatch {
  // A personal-email column can hold a university address and vice versa, so
  // BOTH cells are tried against the verified-address map before either is
  // tried against the weaker sign-in map. Evidence first, column names second.
  const uni = normaliseEmail(row.uniEmail);
  const personal = normaliseEmail(row.email);
  for (const address of [uni, personal]) {
    if (!address) continue;
    const uid = index.byUniEmail.get(address);
    if (uid) return { kind: "uni-email", uid, note: "" };
  }
  for (const address of [uni, personal]) {
    if (!address) continue;
    const uid = index.byEmail.get(address);
    if (uid) return { kind: "personal-email", uid, note: "" };
  }
  const nameKey = normaliseName(row.name);
  if (nameKey) {
    const uids = index.byName.get(nameKey) ?? [];
    if (uids.length === 1) {
      return {
        kind: "name",
        uid: uids[0],
        note: "Matched on name alone. Confirm this is the same person.",
      };
    }
    if (uids.length > 1) {
      return {
        kind: "none",
        uid: null,
        note: `${uids.length} accounts answer to that name, so a name match decides nothing.`,
      };
    }
  }
  return { kind: "none", uid: null, note: "No account matches this person." };
}

export type PlannedRow = ImportCandidate & {
  seq: number;
  rowId: string;
  match: ImportMatch;
};

/**
 * Match every row and mark the second and later lines for one person as
 * duplicates.
 *
 * De-duplication is by MATCHED UID first, and by address or name key when
 * there is no uid: an SU export with one line per transaction lists a person
 * who renewed twice, and two grants for one person in one period are one row
 * in `memberships` either way. Marking it here is what puts it in the receipt
 * rather than leaving an admin to wonder why 600 lines produced 598 people.
 */
export function planImportRows(
  index: MatchIndex,
  candidates: readonly ImportCandidate[],
): PlannedRow[] {
  const seen = new Set<string>();
  const planned: PlannedRow[] = [];
  candidates.forEach((candidate, i) => {
    const seq = i + 1;
    let match = matchCandidate(index, candidate);
    const key = match.uid
      ? `uid:${match.uid}`
      : dedupeKeyFor(candidate);
    if (key !== "" && seen.has(key)) {
      match = {
        kind: "duplicate",
        uid: match.uid,
        note: "The same person appears on an earlier line of this file.",
      };
    } else if (key !== "") {
      seen.add(key);
    }
    planned.push({
      ...candidate,
      seq,
      rowId: membershipImportRowId(seq),
      match,
    });
  });
  return planned;
}

function dedupeKeyFor(candidate: ImportCandidate): string {
  const uni = normaliseEmail(candidate.uniEmail);
  if (uni) return `uni:${uni}`;
  const email = normaliseEmail(candidate.email);
  if (email) return `email:${email}`;
  const name = normaliseName(candidate.name);
  return name ? `name:${name}` : "";
}

export type ImportReceipt = {
  total: number;
  uniEmail: number;
  personalEmail: number;
  needsConfirm: number;
  duplicate: number;
  unmatched: number;
  /** Rows that will be written to `memberships` without anybody looking. */
  autoCommittable: number;
  byTier: Record<MembershipTier, number>;
};

/** The dry-run receipt: what the file is, before anything is committed. */
export function summariseImport(rows: readonly PlannedRow[]): ImportReceipt {
  const receipt: ImportReceipt = {
    total: rows.length,
    uniEmail: 0,
    personalEmail: 0,
    needsConfirm: 0,
    duplicate: 0,
    unmatched: 0,
    autoCommittable: 0,
    byTier: { paid: 0, comped: 0, alumni: 0, staff: 0 },
  };
  for (const row of rows) {
    if (row.match.kind === "uni-email") receipt.uniEmail += 1;
    else if (row.match.kind === "personal-email") receipt.personalEmail += 1;
    else if (row.match.kind === "name") receipt.needsConfirm += 1;
    else if (row.match.kind === "duplicate") receipt.duplicate += 1;
    else receipt.unmatched += 1;
    if (isAutoCommittable(row.match.kind)) {
      receipt.autoCommittable += 1;
      receipt.byTier[row.tier] += 1;
    }
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// The commit planner
// ---------------------------------------------------------------------------

/**
 * One stored row, as the commit planner needs it. A subset of the document so
 * the planner is pure and its test does not need a Firestore.
 */
export type CommittableRow = {
  rowId: string;
  state: MembershipImportRowState;
  matchKind: MembershipImportMatchKind;
  matchedUid: string | null;
  tier: MembershipTier;
};

/** An existing `memberships/{uid}__{periodId}` row, or null. */
export type ExistingMembership = {
  tier: MembershipTier;
  source: string;
} | null;

export type CommitDecision =
  /** Write the row. */
  | { action: "commit"; uid: string; tier: MembershipTier; matchedOn: MembershipMatchedOn }
  /** Leave it pending: a name row nobody has confirmed yet. */
  | { action: "await-confirm"; reason: string }
  /** Stamp it skipped, with the reason, and never look at it again. */
  | { action: "skip"; reason: string }
  /** Already dealt with by an earlier call. */
  | { action: "done" };

/**
 * What to do with one row, given what is already in `memberships`.
 *
 * PURE, and the only place the commit rules live:
 *
 *  - a row already committed or skipped is done. Re-running a commit is a
 *    no-op, which is what makes the chunked commit resumable and what makes
 *    an admin pressing the button twice harmless;
 *  - a name row is refused unless its id is in `confirmedRowIds`. It stays
 *    PENDING rather than being stamped skipped, so confirming it later
 *    commits it;
 *  - an EXISTING membership row is never overwritten, whatever it says. A
 *    `set()` re-run would rewrite `provenance.at`, and worse, it would
 *    silently replace the comped grant an admin made by hand this morning
 *    with the paid row the SU list has been claiming since last week. The
 *    same tier from the same import is reported as already recorded; anything
 *    else is skipped with the disagreement spelled out, for a human to settle
 *    from the Members page.
 */
export function planCommitRow(
  row: CommittableRow,
  existing: ExistingMembership,
  confirmedRowIds: ReadonlySet<string>,
): CommitDecision {
  if (row.state !== "pending") return { action: "done" };
  if (row.matchKind === "duplicate") {
    return { action: "skip", reason: "The same person appears on an earlier line." };
  }
  if (row.matchKind === "none" || !row.matchedUid) {
    return { action: "skip", reason: "No account matches this person." };
  }
  const matchedOn = matchedOnForKind(row.matchKind);
  if (!matchedOn) {
    return { action: "skip", reason: "This row has no usable match." };
  }
  if (row.matchKind === "name" && !confirmedRowIds.has(row.rowId)) {
    return {
      action: "await-confirm",
      reason: "Matched on name alone, so it needs confirming before it commits.",
    };
  }
  if (existing) {
    if (existing.tier === row.tier && existing.source === "su-import") {
      return { action: "skip", reason: "Already recorded from an SU import." };
    }
    return {
      action: "skip",
      reason:
        `Already recorded as ${existing.tier} from ${sourceWords(existing.source)}. `
        + "Change it from the Members page if the SU list is right.",
    };
  }
  return { action: "commit", uid: row.matchedUid, tier: row.tier, matchedOn };
}

function sourceWords(source: string): string {
  if (source === "manual") return "a manual grant";
  if (source === "comp") return "a comped grant";
  if (source === "su-import") return "an SU import";
  return "another source";
}

/**
 * The per-tier deltas a set of committed tiers owes the period's cached
 * totals. Pure, the `membershipTotalsGivenBack` precedent, and applied as ONE
 * update per commit call rather than one per person: 200 increments on a
 * single period document would be 200 writes fighting over one document,
 * where the arithmetic is the same either way.
 */
export function tierDeltas(
  tiers: readonly MembershipTier[],
): Partial<Record<MembershipTier, number>> {
  const deltas: Partial<Record<MembershipTier, number>> = {};
  for (const tier of tiers) deltas[tier] = (deltas[tier] ?? 0) + 1;
  return deltas;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type MembershipImportCounts = {
  uniEmail: number;
  personalEmail: number;
  needsConfirm: number;
  duplicate: number;
  unmatched: number;
};

export type MembershipImportDoc = {
  id: string;
  periodId: string;
  filename: string;
  status: MembershipImportStatus;
  totalRows: number;
  counts: MembershipImportCounts;
  /** Rows written to `memberships` so far. */
  committedRows: number;
  /** Rows stamped skipped, with a reason on each. */
  skippedRows: number;
  /** Name matches on this batch that are still pending. RECOUNTED from the
   *  rows at the end of every commit call, never accumulated as a delta: a
   *  delta that subtracts a confirmation the walk had not yet counted reads
   *  as zero, and a batch with people still waiting gets stamped finished. */
  awaitingConfirm: number;
  /** The next row sequence a commit call starts from. 1 before the first. */
  nextRowSeq: number;
  uploadedAt: Date | null;
  uploadedByUid: string;
  uploadedByName: string;
  lastCommitAt: Date | null;
  lastCommitByUid: string;
};

export type MembershipImportRowDoc = {
  id: string;
  seq: number;
  line: number;
  name: string;
  email: string;
  uniEmail: string;
  tier: MembershipTier;
  matchKind: MembershipImportMatchKind;
  matchedUid: string | null;
  matchNote: string;
  state: MembershipImportRowState;
  skipReason: string;
  committedAt: Date | null;
  confirmedByUid: string;
  confirmedByName: string;
};

type Raw = Record<string, unknown>;

function tsToDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const obj = v as { toDate?: () => Date };
  return typeof obj?.toDate === "function" ? obj.toDate() : null;
}

function str(v: unknown, max?: number): string {
  const s = typeof v === "string" ? v : "";
  return max === undefined ? s : s.slice(0, max);
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function isMatchKind(v: unknown): v is MembershipImportMatchKind {
  return (
    v === "uni-email"
    || v === "personal-email"
    || v === "name"
    || v === "duplicate"
    || v === "none"
  );
}

export function normalizeMembershipImport(id: string, data: Raw): MembershipImportDoc {
  const rawCounts = (data.counts ?? {}) as Raw;
  return {
    id,
    periodId: str(data.periodId),
    filename: str(data.filename, MEMBERSHIP_IMPORT_LIMITS.filename),
    status: isMembershipImportStatus(data.status) ? data.status : "dry-run",
    totalRows: count(data.totalRows),
    counts: {
      uniEmail: count(rawCounts.uniEmail),
      personalEmail: count(rawCounts.personalEmail),
      needsConfirm: count(rawCounts.needsConfirm),
      duplicate: count(rawCounts.duplicate),
      unmatched: count(rawCounts.unmatched),
    },
    committedRows: count(data.committedRows),
    skippedRows: count(data.skippedRows),
    awaitingConfirm: count(data.awaitingConfirm),
    // 0 is not a valid sequence, so an absent cursor reads as "before the
    // first row" rather than as "row zero".
    nextRowSeq: Math.max(1, count(data.nextRowSeq)),
    uploadedAt: tsToDate(data.uploadedAt),
    uploadedByUid: str(data.uploadedByUid),
    uploadedByName: str(data.uploadedByName, MEMBERSHIP_IMPORT_LIMITS.name),
    lastCommitAt: tsToDate(data.lastCommitAt),
    lastCommitByUid: str(data.lastCommitByUid),
  };
}

export function normalizeMembershipImportRow(
  id: string,
  data: Raw,
): MembershipImportRowDoc {
  const state = data.state;
  const tier = data.tier;
  return {
    id,
    seq: count(data.seq),
    line: count(data.line),
    name: str(data.name, MEMBERSHIP_IMPORT_LIMITS.name),
    email: str(data.email, MEMBERSHIP_IMPORT_LIMITS.email),
    uniEmail: str(data.uniEmail, MEMBERSHIP_IMPORT_LIMITS.email),
    tier: isMembershipTier(tier) ? tier : "paid",
    matchKind: isMatchKind(data.matchKind) ? data.matchKind : "none",
    matchedUid: typeof data.matchedUid === "string" && data.matchedUid !== ""
      ? data.matchedUid
      : null,
    matchNote: str(data.matchNote, 200),
    state: state === "committed" || state === "skipped" ? state : "pending",
    skipReason: str(data.skipReason, 200),
    committedAt: tsToDate(data.committedAt),
    confirmedByUid: str(data.confirmedByUid),
    confirmedByName: str(data.confirmedByName, MEMBERSHIP_IMPORT_LIMITS.name),
  };
}

/**
 * Turn parsed cells into candidates. Separate from the parser so a file whose
 * name is split across two columns is joined in ONE place, and so the tier
 * default (what an SU list without a type column means) is visible.
 */
export function candidatesFrom(
  rows: readonly string[][],
  columns: ColumnMap,
  defaultTier: MembershipTier,
): ImportCandidate[] {
  const cell = (row: string[], at: number) => (at >= 0 ? (row[at] ?? "") : "");
  return rows.map((row, i) => {
    const whole = cell(row, columns.name);
    const first = cell(row, columns.firstName);
    const last = cell(row, columns.lastName);
    const name = whole || [first, last].filter(Boolean).join(" ");
    return {
      // The header is line 1, so a data row's line number is its index plus 2.
      line: i + 2,
      name: name.slice(0, MEMBERSHIP_IMPORT_LIMITS.name),
      email: cell(row, columns.email).slice(0, MEMBERSHIP_IMPORT_LIMITS.email),
      uniEmail: cell(row, columns.uniEmail).slice(0, MEMBERSHIP_IMPORT_LIMITS.email),
      tier: tierFromCell(cell(row, columns.tier)) ?? defaultTier,
    };
  });
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** The batch as the console reads it. Field by field, dates as ISO strings.
 *  `uploadedByUid` and `lastCommitByUid` stay behind: the console shows a
 *  name, and a uid in a receipt tells a reader nothing they can act on. */
export function projectImportBatch(batch: MembershipImportDoc) {
  return {
    id: batch.id,
    periodId: batch.periodId,
    filename: batch.filename,
    status: batch.status,
    totalRows: batch.totalRows,
    counts: batch.counts,
    committedRows: batch.committedRows,
    skippedRows: batch.skippedRows,
    awaitingConfirm: batch.awaitingConfirm,
    nextRowSeq: batch.nextRowSeq,
    uploadedAt: batch.uploadedAt ? batch.uploadedAt.toISOString() : null,
    uploadedByName: batch.uploadedByName,
    lastCommitAt: batch.lastCommitAt ? batch.lastCommitAt.toISOString() : null,
  };
}

export type ImportBatchPayload = ReturnType<typeof projectImportBatch>;

/** One row as the confirm list reads it. The matched uid IS included: the
 *  confirm question is "is this the same person", and an admin answering it
 *  needs the account the match landed on. */
export function projectImportRow(row: MembershipImportRowDoc) {
  return {
    rowId: row.id,
    line: row.line,
    name: row.name,
    email: row.email,
    uniEmail: row.uniEmail,
    tier: row.tier,
    matchKind: row.matchKind,
    matchedUid: row.matchedUid,
    matchNote: row.matchNote,
    state: row.state,
    skipReason: row.skipReason,
    confirmedByName: row.confirmedByName,
  };
}

export type ImportRowPayload = ReturnType<typeof projectImportRow>;
