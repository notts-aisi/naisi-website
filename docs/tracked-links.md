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
it. That list is for codes that were printed before the console existed. A new
code is made in the console, before the artwork is final, and needs no code
change.

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

By `src/app/api/q/[slug]/route.ts`, reached through a rewrite in
`next.config.ts` (`/q/:slug` to `/api/q/:slug`). It reads the link's record in
`trackedLinks` and redirects to where the record says. That is what makes a
printed code repointable from the admin console at `/admin/links`, with no
pull request and no deploy.

The order it decides in, and why (`src/lib/campaign/resolveScan.ts`, a pure
function so every branch is tested):

1. **The record**, when the database produced one.
2. **The last record this server saw**, when the database did not answer. A
   code repointed yesterday keeps going to the new place through a blip, and
   does not snap back to where it went on print day.
3. **The printed list**, when there is still nothing. A code that is on paper
   works with no record at all and with Firestore down. No arrangement that
   lives only in the database could promise that.
4. **`/links`, carrying the slug**, for everything else. An unknown or mistyped
   slug never meets a 404, because by the time a typo is found the print run
   exists.

A record that is switched off lands on `/links` and stops there: that is a
decision, and the printed list must not quietly undo it. A record whose stored
destination fails validation is damage, not a decision, so it falls through to
the printed list.

Four properties of that route are load-bearing, and
`tests/tracked-links.test.mjs` holds each:

- **Every printed code answers exactly as it did before the route existed.**
  The test carries a table recorded from production with `curl -sI` and runs it
  through the shipping route with no record, with the database down, with no
  Admin SDK at all, and with the record the console creates. Same status, same
  `Location`, byte for byte.
- **307, never 308.** A 308 is cached by the phone for good: that phone could
  never be sent anywhere else, which would destroy the one property this exists
  for. `Cache-Control: no-store` on every answer.
- **The `Location` is relative and built by hand.** Behind the hosting proxy
  `req.url` carries an internal revision host, so
  `NextResponse.redirect(new URL(path, req.url))` would work on a laptop and
  send every printed code to a dead address in production. A relative
  `Location` depends on no host at all.
- **It is not an open redirector.** A destination comes from the record and
  never from the request. There is no `?to=` and there must never be one.
  `parseDestination()` runs on save and again on every scan, so a value that
  reached the database by any route is checked before it is followed: a path on
  this site, or an `https://` address with no credentials in it. Not `//host`,
  not a backslash, not `javascript:`, not another short link.

### The trap this replaced

Until this route existed the scan was answered by redirect entries in
`next.config.ts`. Next matches redirects **before** rewrites and before the
filesystem, so a `/q/<slug>` redirect left in the config would silently take
over from the route: nothing errors, and repointing a code in the console does
nothing. The test reads the config and allows exactly two entries under `/q`,
the bare prefix and paths of two segments or more, neither of which can match a
slug. To give a slug its own destination, give it a record.

## The console

`/admin/links`, admins only, under `(admin-only)`. Create a link, change where
it goes, relabel it, move it between campaigns, mark it a QR code or a link,
switch it off. Writes are client-direct under an admin-only rule, as the
Sources and Projects tabs are, which is acceptable because the admin tree is
closed during a view-as session.

- **There is no delete**, in the console or in `firestore.rules`, for anybody.
  A printed code's record has to outlive every tidy-up.
- **The slug cannot be edited.** It is the document id and the thing that gets
  printed. Creating one runs in a transaction that refuses a slug already
  taken, because writing over one would repoint somebody else's printed code.
- **The printed codes appear by themselves.** On load the console creates a
  record for any code in the printed list that lacks one, create-only, so
  nobody has to remember a seeding step. Until it has run those codes are
  answered from the same list, so nothing depends on it having run.
- **A campaign is a label on the link**, not a document of its own. A campaign
  exists when a link names it.

### Counting visits to another site

A link to a page on this site is always counted. A link to another site is a
plain redirect and is not, because there is no page of ours to fire the
beacon. Turning on "Count visits to this site" answers the scan with a small
self-contained document that fires the beacon and forwards at once, with a
meta refresh and a plain link behind it.

Off by default, and **no printed code uses it**. A forward made by a script is
not always handed to the destination's app the way a redirect is, so somebody
tapping through to Instagram can land on its website, behind a login wall,
where the redirect would have opened the app. Whether the count is worth that
is a decision for whoever makes the link. `/q/ig` is a plain redirect.

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

The cost of that choice: a link that goes straight to another site has no
first-party page to fire the beacon, so it is not counted unless it is set to
pass through the counting page described above. `/q/ig` is the one printed
code in that position, and stays a plain redirect.

Only a link that exists is counted: a code on the printed list, or a slug with
a record. Anything else is refused, so nobody can mint a document per made-up
string. A printed code is recognised without a database read, so on fair day a
scan costs one write and nothing more.

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

Admins read the collection, for the dashboard, and nobody writes it, admins
included (`scripts/rules-tests/tests/link-scan-days.test.mjs`). A count is only
worth reading if the one thing that can move it is a scan.

## What /links says

`/links` is where most printed codes land, and what it says is edited at
`/admin/links/page-content`: the three application buttons, and the sections of
rows under them. The mailing list form and the upcoming events are always
there and are not edited.

- **It never renders empty or broken.** The rows in `src/content/links.ts` are
  the built-in page. They are shown until somebody saves an edit, and again
  whenever the stored document is missing, damaged, empty, has every row
  hidden, or the database does not answer in time. An admin cannot break the
  page by editing it. `tests/links-page-content.test.mjs` runs the shipping
  fetcher against each of those.
- **A stored address is not trusted for being stored.** Every address passes
  `parseDestination()`, the validator the short links use, when it is saved and
  again when it is read. A row whose address fails is left off the page and the
  rest stay, so a value typed into the Firestore console by hand never becomes
  an anchor on a page strangers open.
- **The document is admin-only to read, although the page is public.** The
  page reads it on the server (`src/features/links/fetchLinksPage.ts`), which
  drops the hidden rows and the editor's uid before anything reaches HTML. The
  sign-up component, a client component, is handed the three buttons' state
  and nothing else, because every prop a Server Component gives a client
  component is serialised into the public HTML whether it is rendered or not.
- **An application button has two states.** Closed, it says "Opens soon" and
  leads to the mailing list form, recording which one the person is waiting
  for in the subscription's `source`. Marked open with an address, it becomes a
  link to the application. Open with nowhere safe to go stays closed.
- **An edit shows within a minute.** The page is static with a one-minute
  revalidate. The save is a client-direct write, so there is no route to
  revalidate from; the short window stands in for it.

## The dashboard

On `/admin/links`, above and inside the list: grouped by campaign, split by
kind, busiest link first, for the last 7 days, the last 30, or all time.

- **Three numbers, and two of them are sign-ups.** Scans, signed up, confirmed.
  A public sign-up is double opt-in, so somebody who types their address at the
  stall is not subscribed until they press a button in an email, often that
  evening on another device. One number would flatter the print run by everyone
  who never opened the mail.
- **People, not rows.** A subscription is one row per address per channel, so
  ticking two boxes on one form makes two rows. Both sign-up numbers count
  distinct addresses. The addresses go no further than the arithmetic in
  `src/lib/campaign/linkStats.ts`: what comes out is counts, and the two CSV
  exports carry counts only. They are not files of named people, which is why
  they are not written to the exports log.
- **A scan count is a floor.** The page says so, in words, under the numbers.
- **Neither read needs a declared index**, and that is a constraint on how
  they are written. Each is a range on ONE field (`date`, and a `qr:` prefix on
  `source`), which the automatic single-field index serves. An `orderBy` on
  another field, or an equality beside the range, would need a composite index;
  the emulator does not enforce indexes, so that would pass every local check
  and fail in production. Sorting and range-switching happen in the browser.
- **The charts show the days nobody scanned.** Leaving them out would put two
  busy days side by side that were a week apart.

## Which sign-ups a code produced

Separate from scan counts, and older. A sign-up made on a page carrying
`?q=<slug>` stores `qr:<slug>` in the subscription's existing `source` field
(`src/lib/campaign/attribution.ts`), with the pressed `/links` button appended
when there was one: `qr:poster:fellowship`. The admin Subscriptions table shows
and exports it. A public sign-up is double opt-in, so "started" and "confirmed"
are different numbers and both are worth reading.

## Checking a deploy

```sh
# Every printed code still answers. Unless one has been repointed in the
# console on purpose, this matches the table in tests/tracked-links.test.mjs.
for s in movie brochure poster join ig; do
  curl -s -o /dev/null -w "$s %{http_code} %{redirect_url}\n" https://naisi.uk/q/$s
done

# The counter took a write. `counted` is false when the database refused it.
# This is a real increment: it adds one scan to `poster` for today.
curl -s -X POST https://naisi.uk/api/q/poster/scan
```
