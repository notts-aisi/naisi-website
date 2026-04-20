/**
 * Small CSV helpers shared by the newsletter subscriber export and the event
 * attendee export. Keep them minimal — Excel opens CSV natively so we don't
 * need a full .xlsx toolchain.
 */

/** Escape a single CSV cell; wraps in quotes when needed, doubles embedded quotes. */
export function escapeCsvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
