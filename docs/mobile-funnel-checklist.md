# The applicant funnel on a phone: device checklist

The 21 and 22 September fairs are phone traffic, and the funnel exists for
them. This is the walk that signs the funnel off before it opens: an ordered
list of steps with what to look at, and which stylesheet to open when something
is wrong.

Do it on real hardware. Playwright is Chromium-only and this codebase has
already shipped a Safari-only button bug (a `<button>` whose inline background
Safari painted its own grey face over), so a green automated run closes nothing
here. The e2e harness in `tests/e2e/` is a regression net for the flow, not a
substitute for this document.

## What you need

- An iPhone, in **Safari**, and an Android handset in **Chrome**. If you only
  have one handset, do the walk twice on it: once in Safari or Chrome, once in
  the other browser installed alongside.
- Both walks against **dev.naisi.uk**, signed in as an ordinary account, with
  an open round and a published course carrying an open-enrol run.
- Repeat the Safari walk once with the site **installed to the home screen**
  (Share, Add to Home Screen). Standalone has no browser chrome to absorb the
  safe-area insets, so a missing inset shows there first. See `docs/pwa.md`.
- Rotate to **landscape** at least once inside the availability grid, on a
  notched device. The notch only intrudes on the left and right edges in
  landscape and DevTools does not model it.

Widths to care about: **375px** (the narrow-phone reference), **414px** (the
common large phone), and **320px** if you still have anything that small. The
CSS breaks at **36rem** (576px) and **48rem** (768px), so a phone in portrait is
always below both and a phone in landscape can cross 36rem.

## The walk, in order

### 1. The catalogue: `/courses`

Governed by `src/app/(public)/courses/courses.module.css` and
`src/features/courses/CourseVisual.module.css`.

- One column of cards, not two squeezed side by side.
- The generated artwork at the top of each card runs the full width of the
  card, flush to its edges, and is not letterboxed or stretched.
- The course title wraps rather than pushing the card sideways. Nothing on the
  page scrolls horizontally.
- The state line at the foot of each card ("Applications open Mon 21 Sep", or
  closed) is legible and sits directly under the tagline rather than being
  pushed to the bottom of an over-tall card.

### 2. The programme page and its call to action: `/courses/[courseId]`

Governed by `src/features/courses/CourseCTA.module.css` (the rest of this page
is PR13's and PR44 covers its cosmetic pass).

- The apply button is full width and comfortably tall. Tap it with a thumb, not
  a fingernail.
- The closing panel around the foot CTA keeps its padding without pushing the
  button narrow.
- The dates line ("Applications close ... Starts ...") wraps cleanly and its
  separator dots do not strand a single word on a line of its own.

### 3. Enrolling in a pre-course group (open-enrol runs only)

Governed by `src/features/courses/GroupPicker.module.css` and
`src/features/courses/DropOutCard.module.css`.

- Each session card is a single tap target you can hit anywhere, and tapping it
  selects the radio.
- **The seats-left count is visible on every card**, on its own line under the
  session name, not squeezed against the right edge or cut off. This is the
  fact somebody chooses on, and it is the one that used to disappear.
- A long group name wraps and the "your group" tag wraps with it rather than
  overflowing.
- If the run has streams, the stream picker is the styled `Select` and its
  sheet opens without the page scrolling behind it.
- Join, then open the leave card: the typed confirmation field is full width,
  the keyboard does not cover it, and the two buttons are each full width.

### 4. Signing in from the form

Governed by the `(auth)` shell, not by this pass, but walk it because the
return address is the whole point.

- From `/apply/[roundId]` while signed out, the sign-in card's button is full
  width and the "Create one" link underneath is separately tappable.
- Sign in, and land **back on the apply form**, not on the dashboard or on
  `/pending-approval`.

### 5. The application form: `/apply/[roundId]`

Governed by `src/app/(public)/apply/[roundId]/apply.module.css` and
`src/features/admissions/ApplyFlow.module.css`.

- The round label wraps. A long one must not set the width of the page.
- The stage strip is one full-width item per stage, stacked.
- Each section is a card with its heading, and the sections give up padding at
  36rem so the content keeps the pixels. Nothing is clipped at either edge.
- **Tap into a text answer and check the page does not zoom.** The answer boxes
  render at 16px through the events `FormRenderer`, which is what stops iOS
  zooming on focus. If it zooms, the field has lost that font size somewhere.
  `FormRenderer.module.css` is mobile-frozen (`docs/mobile-baseline-events.md`)
  and is not this PR's to change: report it rather than patching it here.
- The character counter under a long answer stays visible while the keyboard is
  up.

### 6. The programme preference section

Governed by `src/features/admissions/ProgrammePreference.module.css`.

- The options are a stacked column of full-width pills, each at least a thumb
  tall, never a wrapped row of half-width chips.
- A long stream name wraps to a second line inside its pill and the pill grows
  rather than clipping.
- On a ranked list, the numbers line up down the left edge and the labels start
  at the same x position. This holds on a partly ranked list too: an unranked
  pill reserves the number's column rather than closing it up, so the labels do
  not step in and out as you rank.
- Rank ten or more streams if the round has them, and check the two-digit
  numbers are not clipped.

### 7. The availability grid, the hardest screen here

Governed by `src/features/admissions/AvailabilityGrid.module.css`. This module
is written mobile-first on purpose: the base rules ARE the phone layout, and
the 48rem block is a `min-width` query that widens to the whole week.

- **One day at a time**, chosen from the week strip above the grid. All seven
  day buttons should be on screen at 375px; on a narrower phone the strip
  itself scrolls sideways, which is fine, but the page behind it must not.
- Each strip button is at least a thumb wide and tall, and shows a count of
  what you have marked on that day.
- **Drag down a column and it paints.** It must not scroll the page while you
  are painting, and the page must not keep scrolling after you lift off.
- **Scroll the grid using the times down the left.** That column is the scroll
  handle, deliberately: the cells refuse pans so a drag paints instead. If you
  cannot scroll from the time rail, that is a bug, not a preference.
- Drag back across a painted run and it clears.
- Each quarter-hour cell should be a comfortable target: 44px tall on a phone.
  Hour boundaries read darker so you can find eleven o'clock without counting.
- Turn the phone landscape (crossing 36rem, possibly 48rem on a large handset)
  and back. The grid must survive the transition with the marks intact and
  `<body>` must never scroll sideways.
- **Do not go hunting for a sideways scroll inside the grid.** Seven columns at
  their 3.5rem floor come to 448px, against a container already near 600px at
  768px, so the day columns fit at every width this funnel renders and the
  horizontal scroller in `.cells` is a forward defence for the day the round
  grid widens, not something to verify on a handset. If you ever do see the
  columns scroll, the handle is the head strip along the top (the cells refuse
  pans so a drag paints), and seeing it at all is itself worth reporting.
- The marked count under the grid updates as you paint.

### 8. Access requirements and the privacy notice

Governed by `ApplyFlow.module.css` and the shared `CountedTextarea`.

- The box is full width, the counter is visible, and the copy above it saying
  the box is never scored is legible rather than shrunk to a footnote.
- The privacy notice is readable at a normal reading distance and its link is
  tappable without hitting the text either side of it.

### 9. Saving a draft

Governed by `src/features/admissions/DraftSaveBar.module.css`.

- The bar sits in the flow at the bottom of the form, **not pinned** over the
  grid. That is deliberate: a sticky bar over a 252-cell drag surface covers
  the row somebody is aiming at. Because nothing here is anchored to the
  viewport edge, it asks for no safe-area padding.
- Order on a phone, top to bottom: the Save button, then the "Saved" flash,
  then the status line. The flash is a small pill, not a full-width band.
- Press Save, background the app for a minute, come back, and the status still
  says what it said.
- **Installed to the home screen, confirm the Save button clears the iPhone
  home indicator.** The bar sits in the flow rather than at the viewport edge,
  so it should never need a safe-area inset. Scroll to the very bottom of the
  form and check the button is fully tappable rather than half under the bar
  the system draws there.

### 10. Submitting

- The submit button is full width with its explanatory line under it.
- Submit, and the read-back of your answers renders as text with no horizontal
  scroll, however long an answer was.
- Open the withdraw card. On a small phone **Withdraw and Keep it are stacked,
  each full width**, never a pair of half-width buttons a thumb can catch the
  wrong one of.

### 11. The status hub: `/applications` and `/applications/[roundId]`

Governed by `src/app/(public)/applications/applications.module.css`.

- The list is stacked cards, one per round. There is no table here and there
  should never be one.
- The status badge sits **above** the round's name on a phone, so it is not
  orphaned under a two-line title.
- The facts list under each row wraps rather than scrolling.
- The actions at the foot of a row are stacked, full width, with space between
  them.
- Open a row: the back link at the top is a real tap target, the answers read
  back cleanly, and a shared decision reason (when there is one) is legible.

### 12. Last passes

- **Rotate through the whole form once in landscape** on a notched device.
  Nothing hides under the notch on the left or right edge.
- **Scroll the entire funnel with one finger from the very top to the very
  bottom.** If the page ever moves sideways, note the URL and the section: no
  surface in the funnel is allowed to scroll the document horizontally, and
  every wide thing in it owns an internal scroller instead.
- **Installed to the home screen**, repeat steps 5, 7 and 9. Check nothing sits
  under the status bar at the top or the home indicator at the bottom.

## If something is wrong

Note the step number, the browser, the handset and the width, and open the
module named at the head of that step. The rules that govern the phone layouts
are at the bottom of each file, in a `@media (max-width: 48rem)` block with an
optional `@media (max-width: 36rem)` block after it for small phones
(`docs/mobile-conventions.md`). The availability grid is the exception and
inverts it, as the comment at the top of that file explains.

One cost to know before anybody widens the availability window. The grid's
vertical scroll runs off the time rail, and the rail grows with the cells: at
the 44px phone height, today's 36 quarter-hour slots are already 1584px of
column, and moving the last slot out to 21:00 would make it 48 slots and
2112px. That is a longer rail-only drag on the one screen where a mistaken drag
paints instead of scrolling, so a wider window is a real trade rather than a
free one.

`tests/funnel-mobile-css.test.mjs` pins the parts of this that CSS can assert
on its own: the adapt block at the tail of every funnel module, no custom
property inside a media condition, no fixed width over 20rem outside a media
block (grid tracks included), no `overflow-wrap: break-word` where `anywhere`
is what lowers a box's minimum width, the grid's own scroll container and its
head-strip handle, and the 44px floor on every control named above. It cannot
tell you whether a thumb can hit them, which is what this walk is for.
