import "server-only";

/**
 * THE ESTATE'S SEND PACER. One bounded loop, shared by every route that sends
 * one message per recipient over a list.
 *
 * It lived in `courseFacilitatorEmails.ts` until the notice lane needed it: the
 * event broadcast, the event cancellation and the event announcement dispatch
 * the same way and are not course code, and an events route reaching into a
 * course module for its pacing would have been a coupling nobody could explain
 * a year later. The move is exactly that, a move: same numbers, same
 * arithmetic, same behaviour, and the four course routes now import it from
 * here.
 *
 * FITTING A FULL-SIZE SEND INSIDE THE REQUEST TIMEOUT.
 *
 * `apphosting.yaml` sets `runConfig.timeoutSeconds: 60`. That number, not
 * politeness to the relay, is the binding constraint on how a broadcast is
 * dispatched, because every rate-limit claim in this estate is
 * RESERVE-BEFORE-SEND. A loop killed at the ceiling is the worst outcome in
 * this feature: the response never lands, the slot is already spent, part of
 * the audience has the mail, and the sender's only recourse is a retry that
 * re-mails everyone already delivered.
 *
 * THE ARITHMETIC. The newsletter route paces sequentially with a 200ms sleep,
 * so at most ONE message is in flight. Each send here is a fresh Resend SMTP
 * connection (nodemailer is not pooled), a react-email render and a send-log
 * write: ~0.5s typical, ~1.0s on a bad day. Sequentially that is 0.7-1.2s per
 * recipient, so the run route's own 200-recipient ceiling costs 140-240s, two
 * to four times the timeout, i.e. a full cohort send could not complete at all.
 *
 * So the POSTURE is kept and the MECHANISM is replaced. The point of the 200ms
 * sleep is a bound on how much is in flight at once; a semaphore states that
 * bound explicitly instead of pinning it at one. With `SEND_CONCURRENCY`
 * workers each pausing `PER_SEND_DELAY_MS` after its own send:
 *
 *   run route, full 200:      ceil(200/6) = 34 rounds x 1.05s worst = ~36s (~19s typical)
 *   group route, full 100:    ceil(100/6) = 17 rounds x 1.05s worst = ~18s (~9s typical)
 *   notice lane, full 300:    ceil(300/6) = 50 rounds x 1.05s worst = ~53s (~28s typical)
 *   announcement, full 200:   ceil(200/6) = 34 rounds x 1.05s worst = ~36s (~19s typical)
 *
 * so a full-size send finishes inside the 60s ceiling even pessimistically. The
 * notice lane's 300 is the tightest of the four against that ceiling and is
 * where the sum was redone when it was set.
 *
 * COUNT MESSAGES, NOT RECIPIENTS, WHENEVER THE TWO DIFFER. The first three caps
 * are one address per person, so a recipient IS a send. The event announcement
 * is not: it goes to the `subscriptions` junction, where a member with a
 * verified university address on both channels takes two sends, so its ceiling
 * is `MAX_ANNOUNCEMENT_SENDS` and it is counted on addresses after hydration
 * rather than on the junction rows read before it. Sized at 500 rows, as it
 * first was, that lane was a ~1000-message loop billed against this 60s budget
 * on a request that had already committed its once-per-event claim.
 *
 * THE ANNOUNCEMENT AND THE NEWSLETTER SEND EACH RUN A SECOND LEG (push, ~34s
 * worst at its own ceiling: `src/lib/push/rowAudience.ts` owns that figure and
 * is where it is derived), and each runs it CONCURRENTLY with its email leg for
 * that reason: two bounded loops in one request cost the larger, not the sum.
 * Anything that adds a third serial leg to a request owes this sum again.
 *
 * RAISING ANY RECIPIENT CAP MEANS REDOING THIS SUM. An audience that needs more
 * than one request needs a chunked sender with per-recipient bookkeeping; that
 * is a different feature, and this arithmetic is what says when it is due.
 */
export const SEND_CONCURRENCY = 6;
export const PER_SEND_DELAY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `send` over `items` with at most `SEND_CONCURRENCY` in flight, pausing
 * `PER_SEND_DELAY_MS` between one worker's consecutive sends. Dispatch order is
 * not guaranteed and does not matter: every recipient gets their own message,
 * addressed only to them.
 *
 * `send` MUST RESOLVE. Every caller catches its own per-recipient failures
 * inside it (a send that throws is counted as skipped, never fatal), so a
 * rejection arriving here is a bug, and is deliberately left to reject the
 * request loudly rather than be swallowed into a partial send that reports
 * success.
 */
export async function dispatchSends<T>(
  items: readonly T[],
  send: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Math.min(SEND_CONCURRENCY, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await send(items[index]);
        await sleep(PER_SEND_DELAY_MS);
      }
    }),
  );
}
