import "server-only";

/**
 * IS THE QUEUE THE PATH A PUBLISH WILL TAKE? One answer, asked in two places.
 *
 * The publish route asks it to decide whether to send the new-event
 * announcement inside the request or hand it to the `event-announcements`
 * scheduler job; the manage page asks it so the Publish confirm can say which
 * of those pressing the button does. Those two must never disagree, and the
 * way they cannot is one function reading the switch through the same
 * `jobStateFor` and the same `enabledByDefault` the tick itself uses.
 *
 * IT IMPORTS THE REGISTRATION AND NOT THE REGISTRY. `jobDefaultEnabled(job)`
 * is `job.enabledByDefault !== false` and nothing else, and importing it from
 * `registry.ts` would pull EVERY registered job, and therefore every send door
 * behind them, into the publish request's module graph to answer one boolean.
 * So the rule is written out here instead, next to the read it belongs to.
 * `src/lib/firestore/schedulerConfig.ts` takes the same default as an argument
 * for a related reason, and says so in its own header.
 *
 * `config/scheduler` is closed to every client (`match /config/{doc}` denies
 * read and write outright), which is why the page reads this server-side and
 * hands the answer down as a prop rather than the editor asking for itself.
 */

import type { Firestore } from "firebase-admin/firestore";
import {
  jobStateFor,
  readSchedulerConfig,
} from "@/lib/firestore/schedulerConfig";
import { eventAnnouncementsJob } from "@/lib/scheduler/jobs/eventAnnouncements";

export async function announcementQueueEnabled(db: Firestore): Promise<boolean> {
  const config = await readSchedulerConfig(db);
  return jobStateFor(
    config,
    eventAnnouncementsJob.id,
    // `jobDefaultEnabled` inlined. See the header: importing it costs the
    // whole registry.
    eventAnnouncementsJob.enabledByDefault !== false,
  ).enabled;
}
