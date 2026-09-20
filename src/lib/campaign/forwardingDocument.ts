/**
 * The small page a visitor passes through on the way to ANOTHER site, when a
 * link has been set to count those visits.
 *
 * Scans are counted by a POST fired from a page on this site. A link that goes
 * straight to Instagram has no such page, so it is not counted. A link with
 * `countOffsite` on is answered with this document in place of a redirect: it
 * fires the same counting POST and forwards at once.
 *
 * Off by default, and no printed code uses it. A forward made by a script is
 * not always handed to the destination's app the way a plain redirect is, so
 * somebody tapping through to Instagram can land on its website where the
 * redirect would have opened the app. Whether the count is worth that is a
 * decision for whoever makes the link.
 *
 * Self-contained on purpose: no bundle, no stylesheet, nothing else to fetch,
 * so it forwards as soon as the HTML arrives. Three ways on, in case one is
 * unavailable: the script, a meta refresh two seconds later (no JavaScript, or
 * a Content-Security-Policy that one day refuses inline scripts), and a plain
 * link. Only the first counts the visit, which keeps machines that fetch a
 * page without running it out of the numbers.
 *
 * Both values are written into markup, so both are escaped here however
 * carefully they were validated upstream.
 */
import { PAGE_FLOOR } from "@/theme/brandColors";

// A document with no stylesheet cannot read a CSS custom property, so the two
// colours it needs are mirrored from the dark theme in src/theme/tokens.css
// (--color-text and --color-accent), the way brandColors.ts mirrors the floor.
const TEXT = "#e6eaf2";
const ACCENT = "#6a82ff";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A string literal that is safe inside a `<script>` element. */
function scriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function forwardingDocument(args: {
  /** A validated `https://` address. */
  destination: string;
  /** The counting route for this slug, e.g. `/api/q/ig/scan`. */
  scanPath: string;
}): string {
  const href = escapeHtml(args.destination);
  let host = args.destination;
  try {
    host = new URL(args.destination).hostname.replace(/^www\./, "");
  } catch {
    // Validated upstream; if it somehow is not a URL, show it as it is.
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Taking you to ${escapeHtml(host)}</title>
<meta http-equiv="refresh" content="2;url=${href}">
<style>
html{background:${PAGE_FLOOR};color:${TEXT};font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center}
a{color:${ACCENT}}
</style>
</head>
<body>
<p>Taking you to <a href="${href}" rel="noopener">${escapeHtml(host)}</a>.</p>
<script>try{navigator.sendBeacon(${scriptString(args.scanPath)})}catch(e){}location.replace(${scriptString(args.destination)})</script>
</body>
</html>
`;
}
