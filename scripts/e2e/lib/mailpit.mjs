/**
 * Mailpit's HTTP API as an assertion surface (Phase 4).
 *
 * In local mode run.mjs points the app's SMTP at a Mailpit instance on
 * loopback, so "what email did that request cause?" becomes a queryable fact
 * instead of a thing nobody checks. Everything here is read/delete against
 * Mailpit's own API — no SMTP, no real mailboxes, nothing leaves the machine.
 *
 * Isolation model: assertions are PER-RECIPIENT, not "the whole mailbox".
 * Every fixture address embeds the per-run id, so concurrent batteries (and
 * leftovers from a crashed run) can never satisfy each other's waits. The only
 * global wipe is run.mjs's, once, before any test starts.
 */
const DEFAULT_URL = "http://127.0.0.1:8025";

function apiBase() {
  const raw = process.env.MAILPIT_URL ?? DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MAILPIT_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  // A mail catcher is only a safe place to point assertions (and for run.mjs
  // to aim real SMTP traffic) when it can only ever be this machine.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      `MAILPIT_URL must be loopback, got ${url.hostname}. A remote "mail catcher" ` +
        "is just a mail server someone else runs.",
    );
  }
  return url.origin;
}

async function api(path, init = {}) {
  const res = await fetch(`${apiBase()}${path}`, init);
  if (!res.ok) {
    throw new Error(`Mailpit ${init.method ?? "GET"} ${path} failed (${res.status})`);
  }
  return res.json().catch(() => null);
}

/**
 * True when a Mailpit API answers on MAILPIT_URL. Batteries skip when false.
 *
 * `apiBase()` is called OUTSIDE the try on purpose. It throws for a
 * non-loopback MAILPIT_URL, and that is a refusal, not an outage — swallowing
 * it here would turn "you pointed this at someone else's mail server" into the
 * comfortable message "Mailpit is not answering", and the batteries would skip
 * green instead of stopping. A guard that degrades to a skip is not a guard.
 */
export async function mailpitAvailable() {
  apiBase();
  try {
    const info = await api("/api/v1/info");
    return Boolean(info?.Version ?? info);
  } catch {
    return false;
  }
}

/** Wipes every captured message. run.mjs calls this once per run, up front. */
export async function clearMailbox() {
  await api("/api/v1/messages", { method: "DELETE" });
}

/** Message summaries addressed to `address` (case-insensitive), newest first. */
export async function messagesTo(address) {
  const target = address.toLowerCase();
  const body = await api("/api/v1/messages?limit=500");
  return (body?.messages ?? []).filter((m) =>
    (m.To ?? []).some((t) => (t.Address ?? "").toLowerCase() === target),
  );
}

/** Full message (Text + HTML bodies) by id. */
export function getMessage(id) {
  return api(`/api/v1/message/${encodeURIComponent(id)}`);
}

/**
 * Waits until at least `count` messages exist for `address`, then returns
 * them. SMTP delivery through Mailpit is fast but asynchronous relative to the
 * HTTP response that triggered the send, so polling is load-bearing, not
 * paranoia.
 */
export async function waitForMessagesTo(address, { count = 1, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  for (;;) {
    seen = await messagesTo(address);
    if (seen.length >= count) return seen;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${count} message(s) to ${address} — Mailpit has ` +
          `${seen.length}. Either the send failed (check the local server log) or ` +
          "SMTP is not actually pointed at Mailpit.",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Asserts nothing (new) arrives for `address` inside a settle window. Returns
 * the message count seen, so callers can assert an exact total. The window is
 * short on purpose: this guards "the server decided not to send", where any
 * send it DID attempt is already in flight on loopback.
 */
export async function settleMessagesTo(address, { settleMs = 2000 } = {}) {
  await new Promise((r) => setTimeout(r, settleMs));
  return messagesTo(address);
}

/**
 * PROOF, not assumption, that the server under test sends into THIS Mailpit.
 *
 * The batteries that address `@nottingham.ac.uk` fixtures are only safe if the
 * server's SMTP is the local catcher; sent through the real credentials in
 * `.env.local` they would bounce against the domain production's deliverability
 * depends on. Checking "was I started by run.mjs?" via an env var is a proxy an
 * operator can satisfy by hand while pointing at their own `npm run dev` — so
 * instead this drives an actual send to an undeliverable `.invalid` address
 * (harmless against ANY SMTP configuration) and requires it to land here.
 *
 * @param triggerSend  performs one send to `address` via the server under test
 * @returns null if proven, else the reason to skip
 */
export async function proveSmtpReachesMailpit(address, triggerSend) {
  if (!(await mailpitAvailable())) {
    return "Mailpit is not answering on MAILPIT_URL.";
  }
  try {
    await triggerSend(address);
  } catch (err) {
    return `The probe send failed (${err.message}).`;
  }
  try {
    await waitForMessagesTo(address, { count: 1, timeoutMs: 15000 });
  } catch {
    return (
      `A probe email to ${address} never reached Mailpit. The server under test ` +
      "is NOT sending into this catcher, so batteries that address real domains " +
      "must not run — they would send for real."
    );
  }
  return null;
}

/** Every absolute-or-not URL referenced by an HTML body's href attributes. */
export function hrefUrls(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) =>
    m[1].replaceAll("&amp;", "&"),
  );
}

/** URLs appearing in a plain-text body. */
export function textUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0]);
}
