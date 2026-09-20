# Short links and scan counting

Every QR code the society prints encodes a short first-party address,
`naisi.uk/q/<slug>`, and never the place it goes. Print is permanent and
plans are not: the screening moves, the application form changes host, the
Instagram handle gets renamed. A code that points at our own address can be
sent somewhere else the day after it is printed. A code that points straight
at Instagram cannot.

## The one irreversible thing

A slug that has been printed is permanent. It is never removed, never renamed
and never given to anything else, because the paper it is on cannot be
recalled. The record of what is on paper is `src/lib/campaign/printedLinks.ts`,
and `tests/scan-counting.test.mjs` fails on a change to any entry already in
it. Adding a new one is fine, and should happen before the artwork is final.

Rules for a new slug:

- Lowercase letters, digits and hyphens, sixteen characters at most. The whole
  address should stay at or under 25 characters, which keeps the code at its
  lowest density and readable from across a stall.
- One per piece of material and per placement, never per person. Two posters
  in different rooms are two slugs. That is a breakdown no device information
  could give, and a code handed to one named person would make its daily count
  a record of that person.
- Never `www`. `www.naisi.uk` does not resolve.

## How a scan is answered

Today by the redirects in `next.config.ts`. Each is `permanent: false`, a 307,
which a phone does not cache. `permanent: true` is a 308, cached for good: a
phone that followed one could never be sent anywhere else, which would destroy
the one property this exists for. `tests/campaign-attribution.test.mjs` fails
on a `/q` entry that is not temporary.

An unknown or mistyped slug lands on `/links` and never on a 404, because by
the time a typo is found the print run exists.

If a route ever takes over answering `/q/<slug>` (so a destination can be
changed from the admin console rather than by a pull request), the redirect
entries have to be deleted in the same change. Next matches redirects before
the filesystem and before rewrites, so a leftover entry shadows the route
silently: nothing errors, and the console's destination field does nothing.

## How a scan is counted

The redirect lands the phone on a first-party page carrying `?q=<slug>`.
`ScanBeacon`, mounted once in the root layout, sees it and posts to
`/api/q/<slug>/scan`, which increments a counter. Then it marks the address
bar with `counted=1`, and a marked address is never counted again. That mark is
what stops a phone that reloads a tab it had put to sleep from counting one
person twice, and it means a link somebody copies out of the address bar and
shares is not counted as a scan.

Counted by a POST from the page, and deliberately not on the redirect. Link
previews, mail scanners and prefetchers fetch an address without running its
page. A count taken on the GET would count them, unevenly across codes, and
there would be no way to tell afterwards. They never reach the beacon.
`tests/get-handlers-readonly.test.mjs` keeps an empty allowlist for this
reason and lists `recordScan` among the helpers no GET may call.

The cost of that choice: a code that goes straight to another site has no
first-party page to fire the beacon, so it is not counted. `/q/ig` is the one
such code today.

Only a slug that exists is counted. Anything else is refused, so nobody can
mint a document per made-up string.

The counts are an undercount by design: anyone with JavaScript off, and anyone
who leaves before the page has loaded, is missed. Comparing one code with
another is reliable. The absolute number is a floor.

## What is stored, and what is not

One document per code per London day in `linkScanDays`, id
`{slug}__{YYYY-MM-DD}`:

```
{ slug, date, count, hours: { "00": n, ..., "23": n } }
```

Days and hours are London's, not UTC's. Through British Summer Time a UTC
bucket would put an eleven o'clock queue at ten, and the people reading the
chart stood in that queue.

Nothing else is written: no IP address, no user agent, no referrer, no account
id, no time finer than the hour and no row per scan. The per-address throttle
on the route keeps its counts in memory and never writes them anywhere. No
cookie is set and no browser storage is touched. Nothing here relates to a
person, which is why this shipped without a change to the privacy policy. The
policy says hosting request logs are not used for analytics, and they are not:
counting from them would have been easier and would have made that sentence
false.

Adding any of those fields is a privacy decision, not a code change. It means
a new policy version, and a new version sends every existing member through
re-consent. `tests/scan-counting.test.mjs` holds the written fields to a closed
list so the question is asked before the field ships.

The collection is locked to every client, admins included
(`scripts/rules-tests/tests/link-scan-days.test.mjs`). The rule opens when
something in a browser needs to read it, together with that query.

## Which sign-ups a code produced

Separate from scan counts, and older. A sign-up made on a page carrying
`?q=<slug>` stores `qr:<slug>` in the subscription's existing `source` field
(`src/lib/campaign/attribution.ts`), with the pressed `/links` button appended
when there was one: `qr:poster:fellowship`. The admin Subscriptions table shows
and exports it. A public sign-up is double opt-in, so "started" and "confirmed"
are different numbers and both are worth reading.

## Checking a deploy

```sh
# Every printed code still answers, and where it goes has not moved.
for s in movie brochure poster join ig; do
  curl -s -o /dev/null -w "$s %{http_code} %{redirect_url}\n" https://naisi.uk/q/$s
done

# The counter took a write. `counted` is false when the database refused it.
# This is a real increment: it adds one scan to `poster` for today.
curl -s -X POST https://naisi.uk/api/q/poster/scan
```
