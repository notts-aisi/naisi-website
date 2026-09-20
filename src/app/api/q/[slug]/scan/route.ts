import { NextResponse } from "next/server";
import { isCampaignSlug } from "@/lib/campaign/attribution";
import { isPrintedSlug } from "@/lib/campaign/printedLinks";
import { recordScan } from "@/lib/campaign/scanCounter";
import { trackedLinkExists } from "@/lib/campaign/trackedLinkStore";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * Counts one scan of a printed code: `POST /api/q/<slug>/scan`.
 *
 * Fired by `ScanBeacon` from the page a scan lands on, never by the short
 * link itself. `naisi.uk/q/<slug>` is answered by the GET one directory up,
 * which this route has nothing to do with: a code works whether or not this
 * route is up, and a failure here is invisible to the person holding the
 * phone.
 *
 * A POST, and deliberately not a count taken on the redirect. Link previews,
 * mail scanners and prefetchers fetch a URL without running its page, so they
 * would inflate a count taken on the GET and never reach this. That is also
 * why `tests/get-handlers-readonly.test.mjs` keeps an empty allowlist.
 *
 * Nothing about the caller is read or kept. The address is used for the
 * in-memory throttle below and goes no further: see `recordScan` for the
 * complete list of what is written.
 *
 * Generous per address on purpose. A sports hall full of phones shares one
 * campus address, so a tight cap would drop real scans on the one day that
 * matters. The cap is there to bound what a script can write, not to police
 * a crowd.
 */
const RL_WINDOW_MS = 60_000;
const RL_IP_MAX = 240;

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const ip = clientIp(req);
  const limit = rateLimit(`q:scan:ip:${ip}`, RL_IP_MAX, RL_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const { slug: raw } = await ctx.params;
  const slug = raw.toLowerCase();
  if (!isCampaignSlug(slug)) {
    return NextResponse.json({ error: "Not a slug" }, { status: 400 });
  }
  // Only a link that exists is counted. Without this, anybody could mint a
  // document per made-up slug, and the numbers would fill with strings nobody
  // made. A code that is on paper needs no read to be recognised, so the fair
  // day's scans cost one write each and nothing more.
  if (!isPrintedSlug(slug) && !(await trackedLinkExists(slug))) {
    return NextResponse.json({ error: "Unknown code" }, { status: 404 });
  }

  const counted = await recordScan(slug);
  return NextResponse.json({ ok: true, counted }, { headers: { "Cache-Control": "no-store" } });
}
