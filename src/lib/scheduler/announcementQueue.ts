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
 * IT LIVES HERE RATHER THAN IN THE JOB MODULE because the answer needs
 * `jobDefaultEnabled` from the registry, and the registry imports every job by
 * value: putting this beside the registration would make that a runtime cycle.
 * `src/lib/firestore/schedulerConfig.ts` takes the default as an argument for
 * exactly the same reason, and says so in its own header.
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
import { jobDefaultEnabled } from "@/lib/scheduler/registry";

export async function announcementQueueEnabled(db: Firestore): Promise<boolean> {
  const config = await readSchedulerConfig(db);
  return jobStateFor(
    config,
    eventAnnouncementsJob.id,
    jobDefaultEnabled(eventAnnouncementsJob),
  ).enabled;
}
