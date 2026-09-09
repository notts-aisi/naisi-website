/**
 * THE DOORS A MESSAGE LEAVES THROUGH, in one place.
 *
 * Two guards ask different questions of the same set and were maintained
 * separately: `tests/notification-classification.test.mjs` asks which
 * notification class each send belongs to, and
 * `tests/send-recipient-scope.test.mjs` asks who each send may reach. The
 * second one's copy had three doors missing and a fourth spelled wrong
 * (`pushToRowAudience` for `sendPushToRowAudience`, which a word-boundary match
 * never finds), so a route that delivers web push was never opened by it at
 * all and its uid arrays went unregistered. A list a scanner keys off is not a
 * list to keep two of.
 *
 * The classification guard checks this set against the tree in both
 * directions: an exported wrapper with callers that nobody added here fails
 * there. So this file is the shared source and that check is what keeps it
 * honest for both readers.
 */
export const SEND_DOOR_NAMES = [
  // Primitives.
  "sendEmail",
  "sendNotice",
  "sendNoticePush",
  "mirrorTaskEmailToPush",
  "mirrorCourseDecisionToPush",
  "sendPushToUid",
  // Named wrappers.
  "sendRsvpEmail",
  "sendCollaboratorEmail",
  "sendCourseApplicationEmail",
  "sendCourseDroppedOutEmail",
  "notifyWorksheetEvent",
  "sendAdmissionEmail",
  "sendCourseWeekNudgeEmail",
  "sendWorksheetDueSoonEmail",
  "sendCourseGroupEmail",
  "sendCourseRunEmail",
  "sendEventAnnouncement",
  "sendAnnouncementToRecipient",
  "sendPushToRowAudience",
];

/** Any of the doors, as a call. */
export const SEND_DOOR_CALL = new RegExp(`\\b(?:${SEND_DOOR_NAMES.join("|")})\\s*\\(`);
