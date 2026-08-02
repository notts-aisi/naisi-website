/**
 * Small CSV helpers shared by the newsletter subscriber export and the event
 * attendee export. Keep them minimal — Excel opens CSV natively so we don't
 * need a full .xlsx toolchain.
 */

/**
 * Escape a single CSV cell; wraps in quotes when needed, doubles embedded
 * quotes, and neutralises spreadsheet formulas.
 *
 * The formula guard matters because these exports carry text submitted through
 * UNAUTHENTICATED endpoints — attendee names and free-text RSVP answers from
 * /api/events/[id]/rsvp, subscriber names from /api/subscriptions — and the
 * file is then opened by a committee member or admin. Excel and Sheets execute
 * a cell beginning with =, +, - or @, so a value like `=cmd|'/c calc'!A1`
 * would run on the reviewer's machine. Prefixing with a tab keeps the value
 * readable while stopping it being parsed as a formula.
 */
export function escapeCsvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `\t${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Build a CSV string from a header row + rows of cell values. */
export function toCSV(header: string[], rows: unknown[][]): string {
  const head = header.map(escapeCsvCell).join(",");
  const body = rows.map((r) => r.map(escapeCsvCell).join(",")).join("\n");
  return body ? `${head}\n${body}` : head;
}

/** Trigger a browser download of `content` as a file. Caller handles filename. */
export function downloadCSV(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke after a beat so the download can complete in all browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Copy text to the clipboard. Returns true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
