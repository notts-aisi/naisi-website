/**
 * Mask an email address for display when the viewer should recognise their
 * own address without it being fully exposed (e.g. on the unsubscribe
 * confirmation page, or in the "you already have an account" email which
 * hints at the Google address the recipient registered with).
 *
 *   `marie.smith@example.com` → `m**th@example.com`
 *   `ab@example.com`          → `a**b@example.com`  (last 1 char when local has 2)
 *   `x@example.com`           → `x**@example.com`   (no last chars when local has 1)
 *   empty / malformed         → `***@***`
 */
export function obfuscateEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) return "***@***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length === 1) return `${local}**${domain}`;
  if (local.length === 2) return `${local[0]}**${local[1]}${domain}`;
  return `${local[0]}**${local.slice(-2)}${domain}`;
}
