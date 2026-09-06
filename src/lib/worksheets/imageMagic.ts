/**
 * What a file ACTUALLY is, read from its first bytes.
 *
 * The upload route cannot trust the `Content-Type` a browser puts on a
 * multipart part: it is a claim the client makes about its own file, and the
 * one thing that must not reach `worksheet-uploads/` is an SVG (a document
 * format that can carry script, on a path staff open in a browser tab). A
 * storage rule can only ever see that same claim, which is why
 * `storage.rules` refuses every client write to that prefix and the bytes go
 * through the route instead: this function is the check the rule cannot make.
 *
 * NO `server-only` IMPORT, deliberately. It is pure byte arithmetic with no
 * Firestore, no session and no filesystem, so it stays unit-testable on its
 * own (tests/worksheet-routes.test.mjs calls it directly with hand-built byte
 * arrays). Anything that needs a secret or a handle belongs in the route.
 *
 * The four types are the ones `docs/worksheets.md > Storage` names, and the
 * list is deliberately an ALLOWLIST: a format nobody recognised comes back as
 * null and is refused, rather than being waved through because it did not
 * match the one shape somebody remembered to ban.
 */

export type SniffedImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Does `bytes` carry `ascii` at `offset`? Bounds-checked, never throws. */
function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/** Does `bytes` start with this exact byte sequence? */
function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * The image type these bytes really are, or null.
 *
 * JPEG is matched on three bytes (`FF D8 FF`) rather than the full SOI plus a
 * specific marker, because the fourth byte varies by encoder (E0 for JFIF, E1
 * for Exif, DB for a bare table) and pinning it would refuse perfectly ordinary
 * photographs off a phone. WebP needs BOTH halves of its header: "RIFF" alone
 * is a container that also holds WAV and AVI, so a RIFF file with no "WEBP" at
 * offset 8 is not an image and must not be stored as one.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (!(bytes instanceof Uint8Array)) return null;
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matchesAscii(bytes, 0, "GIF87a") || matchesAscii(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  return null;
}
