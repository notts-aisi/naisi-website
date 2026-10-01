# Backups and recovery

What protects the Firestore data against a bad migration, a mistaken delete, a
wrong rules deploy or a compromised admin, how to get data back, and the record
of the times it has been tried.

## What is switched on

On both projects (production and dev) since 1 October 2026:

| Control | What it gives | How far back |
|---|---|---|
| Point-in-time recovery | The database as it stood at any whole minute | 7 days |
| Daily backup schedule | One full copy a day | 14 days |
| Delete protection | The database itself cannot be deleted by one command | n/a |

Delete protection guards the database, not the documents in it. The first two
are what answer a deleted document.

Not covered by any of this:

- **Uploaded files** (Cloud Storage). A deleted file is not in a Firestore backup.
- **Sign-in accounts** (Firebase Authentication). A deleted account that signs
  in again with Google is given a NEW uid, so the documents keyed on the old
  one are no longer theirs. Recovering a person means restoring their documents
  AND re-linking them, by hand.

## How to get data back

Both paths need the project owner. Sign in, do the work, check it, sign out.

Neither path writes over the live database. Each one creates a NEW database
beside it, which you read from and copy back what is needed.

**From a point in time** (the last 7 days, to the minute):

```sh
gcloud firestore databases clone \
  --source-database='projects/<PROJECT_ID>/databases/(default)' \
  --snapshot-time='<YYYY-MM-DDTHH:MM:00Z>' \
  --destination-database='<name>' --project=<PROJECT_ID>
```

**From a daily backup** (the last 14 days):

```sh
gcloud firestore backups list --project=<PROJECT_ID>
gcloud firestore databases restore --source-backup='<backup resource name>' \
  --destination-database='<name>' --project=<PROJECT_ID>
```

Four things the first drill taught, each of which costs time if you meet it
unprepared:

1. **The command returns in seconds and the copy takes minutes.** Until it is
   finished, queries against the copy answer "Cannot serve requests when the
   database is undergoing a restore". Watch it with
   `gcloud firestore operations list --database='<name>' --project=<PROJECT_ID>`.
2. **Backups cannot be forced.** They are made by the schedule, once a day.
   Point-in-time recovery is the one that works minutes after a mistake.
3. **No browser can read the copy.** Security rules are deployed per database,
   and a new database has none, so every client request is refused, even for
   collections that are public on the live one. Only the owner and the site's
   own server identity can read it. It is still a second copy of members'
   data, so it is deleted as soon as it has done its job.
4. **The copy inherits delete protection**, so deleting it is two commands, and
   the delete fails if you skip the first:

   ```sh
   gcloud firestore databases update --database='<name>' --no-delete-protection --project=<PROJECT_ID>
   gcloud firestore databases delete --database='<name>' --project=<PROJECT_ID>
   gcloud firestore databases list --project=<PROJECT_ID>   # the copy must be gone BEFORE you sign out
   ```

To compare a copy with its source, count documents per collection on both,
reading the source AS OF the snapshot time (`readTime` on the REST aggregation
query). Counting the live database instead compares against writes made since.

## Drill log

| Date | Path | Snapshot | Result | Time to build |
|---|---|---|---|---|
| 1 Oct 2026 | Point-in-time clone, production | 21:48 UTC | 25 collections and 2,945 top-level documents, identical to the source as of the snapshot; the `comments` (21) and `activity` (38) subcollections identical too | 10 min 4 s |

Owed: one restore from a scheduled backup, which could not be run on the day
the schedule was created because the first backup had not been made yet.

## What this means for deletion

A document deleted from the live database can still be recovered from
point-in-time recovery for 7 days and from a backup for 14. Nothing is kept
beyond that. The privacy policy should say so in its retention section, which
is a new policy version and therefore the owner's decision.
