/**
 * `fetch` for the calls the harness makes to SET UP or TEAR DOWN, as distinct
 * from the calls a battery asserts on.
 *
 * It retries ONCE, after a short pause, when no HTTP response arrived at all.
 * undici reports a reset socket, a refused connection and a failed DNS lookup
 * alike as `TypeError: fetch failed`, with the real code on `cause`, and
 * node:test prints only the message. On 8 September 2026 one such failure
 * inside a `before` hook cancelled the whole uni-email gate battery on a
 * deployed run, and the log held nothing but "fetch failed". A response,
 * whatever its status, comes back untouched: a 4xx or a 5xx is the thing the
 * caller checks, and a repeated POST that had in fact been processed would be
 * a second write. The calls routed through here are safe to repeat when NO
 * response came back: a custom token exchanges as often as it is presented, a
 * session cookie minted twice is one orphan cookie, and Mailpit reads are
 * reads.
 *
 * The URL is printed without its query string, because the Identity Toolkit
 * calls carry the web API key there.
 *
 * `tests/e2e-harness-fetch-guard.test.mjs` is why every `fetch(` under
 * `scripts/e2e/lib/` goes through this and nowhere else.
 */

function describe(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url);
  }
}

export async function fetchOrExplain(url, init = undefined, { retries = 1, pauseMs = 1500 } = {}) {
  const method = init?.method ?? "GET";
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = err?.cause;
      const detail = cause?.code ?? cause?.message ?? err?.message ?? String(err);
      if (attempt <= retries) {
        console.warn(
          `[e2e] ${method} ${describe(url)}: no HTTP response (${detail}); ` +
            `retrying once in ${pauseMs}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        continue;
      }
      throw new Error(
        `${method} ${describe(url)}: no HTTP response after ${attempt} attempts (${detail}).`,
        { cause: err },
      );
    }
  }
}
