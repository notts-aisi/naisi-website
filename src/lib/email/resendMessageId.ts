import "server-only";

/**
 * Parse Resend's internal email_id (UUID v4) out of Nodemailer's raw SMTP
 * response. When Resend's 250 line includes the id, it matches the
 * `data.email_id` on later webhook events — letting us attribute a bounce
 * or complaint back to the exact `emailSends` row.
 *
 * Returns `undefined` when no UUID is present. `markSendStatus` falls back
 * to a recipient + recency lookup in that case, so an unparseable response
 * degrades correlation accuracy but doesn't break the send path.
 */
export function parseResendMessageId(
  rawResponse: string | undefined | null,
): string | undefined {
  if (!rawResponse) return undefined;
  const match = rawResponse.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  );
  return match?.[1];
}
