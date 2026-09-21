import { isCampaignSlug } from "@/lib/campaign/attribution";
import { forwardingDocument } from "@/lib/campaign/forwardingDocument";
import { resolveScan } from "@/lib/campaign/resolveScan";
import { lookupTrackedLink } from "@/lib/campaign/trackedLinkStore";

export const dynamic = "force-dynamic";

/**
 * Answers a short link: `naisi.uk/q/<slug>`, reached through the rewrite in
 * `next.config.ts` (`/q/:slug` to `/api/q/:slug`).
 *
 * Under `src/app/api` and behind a rewrite, not at `src/app/q`, so that every
 * guard which walks the API tree walks this too. The rewrite means the proxy
 * sees `/q/...`, which its matcher does not cover, so its check for an encoded
 * separator never runs for this route. The slug grammar below is tighter than
 * that check (lowercase letters, digits and hyphens only), and it runs before
 * the slug is used to address a document.
 *
 * READ-ONLY, and it must stay that way. A GET is fetched by link previews,
 * mail scanners and prefetchers, so a count taken here would count machines.
 * Scans are counted by `POST /api/q/[slug]/scan`, fired by the page the scan
 * lands on. `tests/get-handlers-readonly.test.mjs` fails a GET that calls
 * `recordScan`, and this file must never import it.
 *
 * NEVER takes a destination from the request. There is no `?to=` and there
 * must never be one: that would make `naisi.uk/q/...` a way to bounce
 * somebody to an arbitrary site under a university society's name. The
 * destination comes from the record, validated again on every scan.
 *
 * 307, never 308. A 308 is cached by the phone for good, and the point of a
 * short link is that where it goes can change after it is printed.
 *
 * THE LOCATION IS RELATIVE for a page on this site, and built by hand. Behind
 * the hosting proxy `req.url` carries the internal revision host, so
 * `NextResponse.redirect(new URL(path, req.url))` would send every printed
 * code to an address nobody outside Google can open, while working perfectly
 * on a laptop. A relative `Location` depends on no host at all, and is what
 * the redirects this route replaced sent.
 */
function ownOrigins(): string[] {
  try {
    return process.env.NEXT_PUBLIC_APP_URL ? [new URL(process.env.NEXT_PUBLIC_APP_URL).origin] : [];
  } catch {
    return [];
  }
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await ctx.params;
  // A code somebody retypes by hand arrives as /q/POSTER.
  const slug = raw.toLowerCase();
  if (!isCampaignSlug(slug)) return redirect("/links");

  const answer = resolveScan(slug, await lookupTrackedLink(slug), ownOrigins());
  if (!answer.hop) return redirect(answer.location);

  return new Response(
    forwardingDocument({
      destination: answer.location,
      scanPath: `/api/q/${encodeURIComponent(slug)}/scan`,
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}
