import "server-only";

/**
 * Parse SES's message ID out of Nodemailer's raw SMTP response line.
 *
 * SES returns a 250-line of the form:
 *   "250 Ok 01000196b4aefdc8-abc12345-6789-0abc-def0-123456789abc-000000"
 * The trailing token is the ID we match against `mail.messageId` in bounce /
 * complaint notifications. Matching on this lets us attribute a specific
 * bounce back to the exact `emailSends` row that caused it.
 *
 * Returns `undefined` when the response isn't a SES-shaped 250 line — we'd
 * rather log an "unlinked" send than fail the whole mail path. Consumer code
 * treats `sesMessageId` as optional.
 */
export function parseSesMessageId(rawResponse: string | undefined | null): string | undefined {
  if (!rawResponse) return undefined;
  // SES IDs are dash-separated hex groups; keep the match strict so a benign
  // non-SES response (e.g., a Mailtrap or dev relay) doesn't grab a spurious
  // token. Minimum length guards against matching short identifiers.
  const match = rawResponse.match(/\b([0-9a-f]{16,}(?:-[0-9a-f]+){2,})\b/i);
  return match?.[1];
}
