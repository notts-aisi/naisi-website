"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import DateTimePopover from "@/components/ui/DateTimePopover";
import { Field, Input, Textarea } from "@/components/ui/Input";
import Link from "next/link";
import ResponsiveSelect from "@/components/ui/ResponsiveSelect";
import { useAuth } from "@/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase/client";
import {
  COVER_BRANDING_LABEL,
  COVER_LOGO_SCALE_DEFAULT,
  COVER_LOGO_X_DEFAULT,
  COVER_LOGO_Y_DEFAULT,
  COVER_STRIP_SIZE_DEFAULT,
  EVENT_STATUS_LABEL,
  FOOD_TAGS,
  FOOD_TAG_LABEL,
  FOOD_TEXT_MAX,
  LOCATION_MAX,
  TITLE_MAX,
  normalizeEvent,
  type CoverBranding,
  type CoverLogoColor,
  type CoverLogoPosition,
  type EventDoc,
  type EventStatus,
  type EventVisibility,
  type FoodTag,
  type FormQuestion,
} from "@/lib/firestore/events";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import type { EventChange } from "@/lib/events/changeSummary";
import { canApproveEvent, canDraftEvent } from "@/lib/firestore/users";
import BlockEditor from "@/features/newsletter/editor/BlockEditor";
import ImageUpload from "@/features/newsletter/editor/ImageUpload";
import {
  approveEvent,
  deleteEvent,
  rejectEvent,
  revertEventToDraft,
  submitEventForReview,
  updateEvent,
} from "./eventMutations";
import CollaboratorPicker from "./CollaboratorPicker";
import CoverBrandingModal from "./CoverBrandingModal";
import FormBuilder from "./FormBuilder";
import styles from "./EventEditor.module.css";

type Props = { eventId: string };

function statusTone(status: EventStatus): "neutral" | "accent" | "success" | "danger" | "warning" {
  switch (status) {
    case "draft":
      return "neutral";
    case "pending":
      return "warning";
    case "approved":
      return "accent";
    case "published":
      return "success";
    case "rejected":
      return "danger";
    case "cancelled":
      return "danger";
  }
}

/** Local YYYY-MM-DD — used to keep the end-date picker on or after the start day. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Join label fragments as "a", "a and b", or "a, b and c". */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Pre-fill the attendee-notification draft from what an edit changed. The
 * notify-worthy set is date/time, location, and the description, so the
 * pre-filled subject and body reflect any combination of those.
 */
function buildNotifyDraft(
  changes: EventChange[],
  descriptionChanged: boolean,
): {
  subject: string;
  body: string;
} {
  const parts: string[] = [];
  if (changes.some((c) => c.label === "When")) parts.push("time");
  if (changes.some((c) => c.label === "Where")) parts.push("location");
  if (descriptionChanged) parts.push("description");
  const subject = parts.length > 0 ? `Update: ${joinList(parts)}` : "Event update";
  let body =
    "Quick heads-up: we've updated some details for this event. " +
    "What changed is summarised below, with the latest full details underneath.";
  if (descriptionChanged) {
    body +=
      " The event description has changed too, so it's worth a fresh read.";
  }
  body +=
    " Apologies for any inconvenience, and let us know if you can no longer make it.";
  return { subject, body };
}

export default function EventEditor({ eventId }: Props) {
  const router = useRouter();
  const { user, role, permissions, suRecognised } = useAuth();

  const [event, setEvent] = useState<EventDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [title, setTitle] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [endAt, setEndAt] = useState<Date | null>(null);
  const [location, setLocation] = useState("");
  const [locationHidden, setLocationHidden] = useState(false);
  const [locationPublicText, setLocationPublicText] = useState("");
  const [visibility, setVisibility] = useState<EventVisibility>("public");
  const [capacity, setCapacity] = useState<number | null>(null);
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [signupForm, setSignupForm] = useState<FormQuestion[]>([]);
  const [foodText, setFoodText] = useState("");
  const [dietaryTags, setDietaryTags] = useState<FoodTag[]>([]);
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [coverBranding, setCoverBranding] = useState<CoverBranding>("none");
  const [coverLogoColor, setCoverLogoColor] = useState<CoverLogoColor>("white");
  const [coverStripSize, setCoverStripSize] = useState(COVER_STRIP_SIZE_DEFAULT);
  const [coverLogoPosition, setCoverLogoPosition] =
    useState<CoverLogoPosition>("bottom");
  const [coverLogoScale, setCoverLogoScale] = useState(COVER_LOGO_SCALE_DEFAULT);
  const [coverLogoX, setCoverLogoX] = useState(COVER_LOGO_X_DEFAULT);
  const [coverLogoY, setCoverLogoY] = useState(COVER_LOGO_Y_DEFAULT);
  const [coverLogoBackdrop, setCoverLogoBackdrop] = useState(true);
  const [coverLogoShadow, setCoverLogoShadow] = useState(true);
  const [brandingModalOpen, setBrandingModalOpen] = useState(false);

  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [publishStatus, setPublishStatus] = useState<
    | { kind: "idle" }
    | { kind: "publishing" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // After editing a published event, offer to email confirmed attendees.
  // The opt-in checkbox by Save gates whether the composer opens at all.
  const [notifyOnSave, setNotifyOnSave] = useState(false);
  const [notifyDraft, setNotifyDraft] = useState<{
    subject: string;
    body: string;
    changes: EventChange[];
    descriptionChanged: boolean;
  } | null>(null);
  const [notifyState, setNotifyState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; sent: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Cancel-with-notify modal. Cancelling sets the event to "cancelled" and,
  // when the tick is on, emails confirmed + waitlisted attendees.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelNotify, setCancelNotify] = useState(true);
  const [cancelNote, setCancelNote] = useState("");
  const [cancelState, setCancelState] = useState<
    | { kind: "idle" }
    | { kind: "cancelling" }
    | { kind: "done"; notified: boolean; sent: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "events", eventId),
      (snap) => {
        if (!snap.exists()) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const next = normalizeEvent(snap.id, snap.data());
        setEvent(next);
        setTitle((cur) => (dirty ? cur : next.title));
        setBlocks((cur) => (dirty ? cur : next.blocks));
        setStartAt((cur) => (dirty ? cur : next.startAt));
        setEndAt((cur) => (dirty ? cur : next.endAt));
        setLocation((cur) => (dirty ? cur : next.location));
        setLocationHidden((cur) => (dirty ? cur : next.locationHidden));
        setLocationPublicText((cur) => (dirty ? cur : next.locationPublicText ?? ""));
        setVisibility((cur) => (dirty ? cur : next.visibility));
        setCapacity((cur) => (dirty ? cur : next.capacity));
        setWaitlistEnabled((cur) => (dirty ? cur : next.waitlistEnabled));
        setSignupForm((cur) => (dirty ? cur : next.signupForm));
        setFoodText((cur) => (dirty ? cur : next.foodText ?? ""));
        setDietaryTags((cur) => (dirty ? cur : next.dietaryTags ?? []));
        setPosterUrl((cur) => (dirty ? cur : next.posterUrl ?? null));
        setCoverBranding((cur) => (dirty ? cur : next.coverBranding));
        setCoverLogoColor((cur) => (dirty ? cur : next.coverLogoColor));
        setCoverStripSize((cur) => (dirty ? cur : next.coverStripSize));
        setCoverLogoPosition((cur) => (dirty ? cur : next.coverLogoPosition));
        setCoverLogoScale((cur) => (dirty ? cur : next.coverLogoScale));
        setCoverLogoX((cur) => (dirty ? cur : next.coverLogoX));
        setCoverLogoY((cur) => (dirty ? cur : next.coverLogoY));
        setCoverLogoBackdrop((cur) => (dirty ? cur : next.coverLogoBackdrop));
        setCoverLogoShadow((cur) => (dirty ? cur : next.coverLogoShadow));
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setError(err.message);
        setLoading(false);
      },
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const viewer =
    role && (role === "admin" || role === "committee" || role === "member")
      ? { role, permissions }
      : null;
  const canDraft = viewer ? canDraftEvent(viewer) : false;
  const canApprove = viewer ? canApproveEvent(viewer) : false;

  const isAuthor = !!user && !!event && event.authorUid === user.uid;
  // A collaborator was explicitly added (by the author or an admin) so they
  // can edit this specific event, even without draft/approve permissions.
  const isCollaborator =
    !!user && !!event && (event.collaboratorUids ?? []).includes(user.uid);
  // The "Who can edit this" picker is managed by the author or an admin.
  const canManageCollaborators = isAuthor || role === "admin";
  // Attendee PII is for SU-recognised committee and admins only.
  const canSeeAttendees =
    role === "admin" || (role === "committee" && suRecognised);
  const status = event?.status ?? "draft";
  const editable = useMemo(() => {
    if (!event) return false;
    if (status === "cancelled") return false;
    // Published events stay editable for approvers via the server update route.
    if (status === "published") return canApprove;
    // While an event is under review or approved, only approvers touch it.
    if (status === "pending") return canApprove;
    if (status === "approved") return canApprove;
    // Drafts and returned events: the author, a collaborator, or an approver.
    return isAuthor || isCollaborator || canApprove;
  }, [event, status, canApprove, isAuthor, isCollaborator]);

  // An event can't end before (or exactly when) it starts. This blocks Save and
  // Submit, but never the date fields themselves — an event that somehow holds
  // an invalid end must always be editable back to valid.
  const endBeforeStart = !!(
    startAt &&
    endAt &&
    endAt.getTime() <= startAt.getTime()
  );

  function markDirty() {
    setDirty(true);
  }

  async function flush() {
    if (!event) return;
    if (!dirty) return;
    const fields = {
      title,
      blocks,
      startAt,
      endAt,
      location,
      locationHidden,
      locationPublicText: locationHidden ? locationPublicText : null,
      visibility,
      capacity,
      waitlistEnabled: capacity === null ? false : waitlistEnabled,
      signupForm,
      foodText: foodText.trim() ? foodText : null,
      dietaryTags,
      posterUrl,
      coverBranding,
      coverLogoColor,
      coverStripSize,
      coverLogoPosition,
      coverLogoScale,
      coverLogoX,
      coverLogoY,
      coverLogoBackdrop,
      coverLogoShadow,
    };
    if (status === "published") {
      // Firestore rules block client writes to published events — go through
      // the server route, which also reports what changed.
      const res = await fetch(`/api/events/${event.id}/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...fields,
          startAt: startAt ? startAt.toISOString() : null,
          endAt: endAt ? endAt.toISOString() : null,
        }),
      });
      const resBody = (await res.json().catch(() => null)) as
        | {
            ok?: true;
            changeSummary?: EventChange[];
            descriptionChanged?: boolean;
            error?: string;
          }
        | null;
      if (!res.ok || !resBody?.ok) {
        throw new Error(resBody?.error ?? `Save failed (${res.status})`);
      }
      // Only open the notify composer when the organiser opted in and there
      // was a notify-worthy change (time, location, or description).
      // Otherwise the save is silent.
      const summary = resBody.changeSummary ?? [];
      const descriptionChanged = resBody.descriptionChanged === true;
      if (notifyOnSave && (summary.length > 0 || descriptionChanged)) {
        setNotifyDraft({
          ...buildNotifyDraft(summary, descriptionChanged),
          changes: summary,
          descriptionChanged,
        });
        setNotifyState({ kind: "idle" });
      }
      setNotifyOnSave(false);
    } else {
      await updateEvent(event.id, fields);
    }
    setDirty(false);
  }

  async function onSave() {
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      await flush();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSendNotify() {
    if (!event || !notifyDraft) return;
    if (!notifyDraft.subject.trim() || !notifyDraft.body.trim()) {
      setNotifyState({ kind: "error", message: "Add a subject and message before sending." });
      return;
    }
    setNotifyState({ kind: "sending" });
    try {
      const res = await fetch(`/api/events/${event.id}/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: notifyDraft.subject,
          body: notifyDraft.body,
          changes: notifyDraft.changes,
          descriptionChanged: notifyDraft.descriptionChanged,
        }),
      });
      const resBody = (await res.json().catch(() => null)) as
        | { ok?: true; sent?: number; error?: string }
        | null;
      if (!res.ok || !resBody?.ok) {
        setNotifyState({
          kind: "error",
          message: resBody?.error ?? `Send failed (${res.status})`,
        });
        return;
      }
      setNotifyState({ kind: "sent", sent: resBody.sent ?? 0 });
    } catch (err) {
      setNotifyState({
        kind: "error",
        message: err instanceof Error ? err.message : "Send failed",
      });
    }
  }

  function validateBeforeSubmit(): string | null {
    if (!title.trim()) return "Give the event a title before submitting.";
    if (blocks.length === 0) return "Add a description block before submitting.";
    if (!startAt) return "Pick a start date/time.";
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      return "An event can't end before it starts.";
    }
    if (!location.trim()) return "Add a location (room, venue, or link).";
    if (locationHidden && !locationPublicText.trim()) {
      return "You've hidden the exact location — add a fuzzy label to show publicly (e.g. 'somewhere on campus').";
    }
    if (capacity !== null && capacity <= 0) return "Capacity must be at least 1 (or blank for unlimited).";
    for (const q of signupForm) {
      if (!q.label.trim()) return "Every signup question needs a label.";
      if ((q.type === "singleSelect" || q.type === "multiSelect")) {
        const cleaned = q.options.map((o) => o.trim()).filter(Boolean);
        if (cleaned.length < 2) return `"${q.label}" needs at least two options.`;
      }
    }
    return null;
  }

  async function onSubmitForReview() {
    if (!event) return;
    const invalid = validateBeforeSubmit();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await flush();
      await submitEventForReview(event.id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      await flush();
      await approveEvent(event.id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    if (!event) return;
    if (!rejectNote.trim()) {
      setError("Leave a note so the author knows what to change.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rejectEvent(event.id, rejectNote);
      setRejectNote("");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevertToDraft() {
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      await revertEventToDraft(event.id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Could not revert");
    } finally {
      setBusy(false);
    }
  }

  async function onPublish() {
    if (!event) return;
    if (!window.confirm("Publish this event? It will be visible on the events page.")) return;
    setPublishStatus({ kind: "publishing" });
    setError(null);
    try {
      const res = await fetch(`/api/events/${event.id}/publish`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { ok?: true; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setPublishStatus({
          kind: "error",
          message: body?.error ?? `Publish failed (${res.status})`,
        });
        return;
      }
      setPublishStatus({ kind: "idle" });
    } catch (err) {
      setPublishStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Publish error",
      });
    }
  }

  function openCancelModal() {
    setCancelNotify(true);
    setCancelNote("");
    setCancelState({ kind: "idle" });
    setCancelOpen(true);
  }

  async function onConfirmCancel() {
    if (!event) return;
    setCancelState({ kind: "cancelling" });
    try {
      const res = await fetch(`/api/events/${event.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notify: cancelNotify, note: cancelNote }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; notified?: boolean; sent?: number; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setCancelState({
          kind: "error",
          message: body?.error ?? `Cancel failed (${res.status})`,
        });
        return;
      }
      setCancelState({
        kind: "done",
        notified: body.notified ?? false,
        sent: body.sent ?? 0,
      });
    } catch (err) {
      setCancelState({
        kind: "error",
        message: err instanceof Error ? err.message : "Cancel failed",
      });
    }
  }

  async function onArchive() {
    if (!event) return;
    const next = !event.archived;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${event.id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: next }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `Archive failed (${res.status})`);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!event) return;
    if (!window.confirm("Permanently delete this event? This can't be undone.")) return;
    setBusy(true);
    try {
      // deleteEvent now routes through /api/events/[id]/delete, which removes
      // EVERY RSVP (synthetic and real) plus the event's images before deleting
      // the doc. The old best-effort test-rsvps call is gone: it only cleared
      // synthetic rows, so real attendees' details were left stranded.
      await deleteEvent(event.id);
      router.push("/events/manage");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Loading event…</p>
      </Card>
    );
  }

  if (notFound || !event) {
    return (
      <Card padding="md">
        <p style={{ color: "var(--color-text-muted)" }}>Event not found. It may have been deleted.</p>
      </Card>
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.statusBar}>
        <div className={styles.statusMeta}>
          <Badge tone={statusTone(status)}>{EVENT_STATUS_LABEL[status]}</Badge>
          {event.archived && <Badge tone="neutral">Archived</Badge>}
          <span className={styles.muted}>by {event.authorDisplayName ?? "unknown"}</span>
          {event.publishedAt && (
            <span className={styles.muted}>
              · published {event.publishedAt.toLocaleDateString()}
            </span>
          )}
        </div>
        <div className={styles.spacer} />
        {dirty && editable && <span className={styles.muted}>Unsaved changes</span>}
        <Link
          href={`/events/manage/${event.id}/preview`}
          target="_blank"
          rel="noopener"
        >
          <Button variant="ghost">Preview ↗</Button>
        </Link>
        {canSeeAttendees && (
          <Link href={`/events/manage/${event.id}/attendees`}>
            <Button variant="ghost">
              Attendees
              {(event.rsvpCountPending ?? 0) > 0 && ` · ${event.rsvpCountPending} pending`}
            </Button>
          </Link>
        )}
      </div>

      {(status === "pending" || status === "approved") && (
        <Card padding="md">
          <strong>
            {status === "pending"
              ? "Submitted for review."
              : "Approved — ready to publish."}
          </strong>
          <p style={{ marginTop: "var(--space-2)", color: "var(--color-text-muted)" }}>
            Want to test the signup flow end-to-end?{" "}
            <Link
              href={`/events/manage/${event.id}/preview`}
              target="_blank"
              rel="noopener"
              style={{ color: "var(--color-accent)" }}
            >
              Open the preview
            </Link>{" "}
            and submit a test RSVP — it&apos;ll land in Firestore so you can verify the
            data shape. Cancel it before the event goes live.
          </p>
        </Card>
      )}

      {status === "published" && (
        <Card padding="md">
          <strong>Published.</strong>
          <p style={{ marginTop: "var(--space-2)", color: "var(--color-text-muted)" }}>
            Live at{" "}
            <Link
              href={`/events/${event.id}`}
              target="_blank"
              rel="noopener"
              style={{ color: "var(--color-accent)" }}
            >
              /events/{event.id}
            </Link>
            . Share the link. Edits you save here go live immediately.
          </p>
        </Card>
      )}

      {notifyDraft && (
        <Card padding="lg">
          <h2 className={styles.sectionTitle}>Notify attendees</h2>
          <p className={styles.sectionHint}>
            You changed details on a published event. The summary below is
            included in the email automatically; the message is your own note
            alongside it.
          </p>
          {(notifyDraft.changes.length > 0 || notifyDraft.descriptionChanged) && (
            <div className={styles.changeSummary}>
              {notifyDraft.changes.map((c) => (
                <p key={c.label} className={styles.changeRow}>
                  <strong>{c.label}: </strong>
                  <span className={styles.changeOld}>{c.from}</span>
                  <span className={styles.changeArrow}> → </span>
                  <span className={styles.changeNew}>{c.to}</span>
                </p>
              ))}
              {notifyDraft.descriptionChanged && (
                <p className={styles.changeRow}>
                  <strong>Description: </strong>
                  <span className={styles.changeNew}>
                    the event description has been updated
                  </span>
                </p>
              )}
            </div>
          )}
          <div className={styles.fields}>
            <Field id="notify-subject" label="Subject">
              <Input
                id="notify-subject"
                value={notifyDraft.subject}
                onChange={(e) =>
                  setNotifyDraft({ ...notifyDraft, subject: e.target.value })
                }
                maxLength={150}
                disabled={notifyState.kind === "sending"}
              />
            </Field>
            <Field id="notify-body" label="Message">
              <Textarea
                id="notify-body"
                value={notifyDraft.body}
                onChange={(e) =>
                  setNotifyDraft({ ...notifyDraft, body: e.target.value })
                }
                rows={5}
                maxLength={8000}
                disabled={notifyState.kind === "sending"}
              />
            </Field>
          </div>
          {notifyState.kind === "error" && (
            <p className={styles.danger} style={{ marginTop: "var(--space-2)" }}>
              {notifyState.message}
            </p>
          )}
          {notifyState.kind === "sent" && (
            <p className={styles.muted} style={{ marginTop: "var(--space-2)" }}>
              Sent to {notifyState.sent} attendee{notifyState.sent === 1 ? "" : "s"}.
            </p>
          )}
          <div
            className={styles.editorActions}
            style={{ marginTop: "var(--space-3)" }}
          >
            {notifyState.kind !== "sent" && (
              <Button onClick={onSendNotify} disabled={notifyState.kind === "sending"}>
                {notifyState.kind === "sending" ? "Sending…" : "Send to attendees"}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setNotifyDraft(null);
                setNotifyState({ kind: "idle" });
              }}
              disabled={notifyState.kind === "sending"}
            >
              {notifyState.kind === "sent" ? "Close" : "Dismiss"}
            </Button>
          </div>
        </Card>
      )}

      {status === "rejected" && event.reviewerNotes && (
        <Card padding="md">
          <strong style={{ color: "var(--color-danger)" }}>Returned for revisions</strong>
          <p style={{ marginTop: "var(--space-2)", color: "var(--color-text)" }}>
            {event.reviewerNotes}
          </p>
        </Card>
      )}

      <Card padding="lg">
        <div className={styles.fields}>
          <Field id="title" label="Event title" hint="Shown on the events list and booking page.">
            <Input
              id="title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                markDirty();
              }}
              maxLength={TITLE_MAX}
              disabled={!editable || busy}
              placeholder="e.g. April fellowship social"
            />
          </Field>

          <div className={styles.twoCol}>
            <Field id="start" label="Starts" hint="Local time. You can adjust after creation.">
              <DateTimePopover
                value={startAt}
                onChange={(next) => {
                  setStartAt(next);
                  markDirty();
                }}
                disabled={!editable || busy}
                placeholder="Pick a start date & time…"
              />
            </Field>
            <Field
              id="end"
              label="Ends (optional)"
              hint="Leave blank if you're not sure yet."
              error={endBeforeStart ? "An event can't end before it starts" : undefined}
            >
              <DateTimePopover
                value={endAt}
                onChange={(next) => {
                  setEndAt(next);
                  markDirty();
                }}
                disabled={!editable || busy}
                placeholder="Pick an end date & time…"
                minDate={startAt ? ymd(startAt) : undefined}
                invalid={endBeforeStart}
              />
            </Field>
          </div>

          <Field
            id="location"
            label="Location (exact)"
            hint="Room, venue, or Zoom URL. Only shared publicly unless you hide it below."
          >
            <Input
              id="location"
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                markDirty();
              }}
              maxLength={LOCATION_MAX}
              disabled={!editable || busy}
              placeholder="e.g. Pope A17, Jubilee Campus"
            />
          </Field>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={locationHidden}
              onChange={(e) => {
                setLocationHidden(e.target.checked);
                markDirty();
              }}
              disabled={!editable || busy}
            />
            Hide the exact location publicly until an RSVP is approved
          </label>

          {locationHidden && (
            <Field
              id="location-public-text"
              label="Public placeholder"
              hint="What visitors see until they're approved. Day and time still show."
            >
              <Input
                id="location-public-text"
                value={locationPublicText}
                onChange={(e) => {
                  setLocationPublicText(e.target.value);
                  markDirty();
                }}
                maxLength={LOCATION_MAX}
                disabled={!editable || busy}
                placeholder="e.g. somewhere on University Park campus"
              />
            </Field>
          )}

          <div className={styles.twoCol}>
            <Field id="visibility" label="Who can RSVP?">
              <ResponsiveSelect<EventVisibility>
                value={visibility}
                onChange={(next) => {
                  setVisibility(next);
                  markDirty();
                }}
                options={[
                  {
                    value: "public",
                    label: "Public — anyone with the link (email only)",
                  },
                  { value: "members", label: "Members only — must sign in" },
                ]}
                disabled={!editable || busy}
                ariaLabel="Who can RSVP?"
              />
            </Field>

            <Field id="capacity" label="Capacity (optional)" hint="Leave blank for unlimited.">
              <input
                id="capacity"
                type="number"
                min={1}
                className={styles.fieldInput}
                value={capacity ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setCapacity(e.target.value === "" || Number.isNaN(n) ? null : Math.floor(n));
                  markDirty();
                }}
                disabled={!editable || busy}
                placeholder="e.g. 30"
              />
            </Field>
          </div>

          {capacity !== null && (
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={waitlistEnabled}
                onChange={(e) => {
                  setWaitlistEnabled(e.target.checked);
                  markDirty();
                }}
                disabled={!editable || busy}
              />
              Once full, let people join a waitlist (auto-promoted on cancellations)
            </label>
          )}
        </div>
      </Card>

      <section>
        <h2 className={styles.sectionTitle}>Cover image</h2>
        <p className={styles.sectionHint}>
          Optional. Shown as a banner across the top of the public event page.
        </p>
        <ImageUpload
          draftId={event.id}
          storagePrefix="event-images"
          enableCrop
          currentUrl={posterUrl ?? undefined}
          onChange={({ url }) => {
            const next = url || null;
            // A freshly uploaded or replaced cover — open the branding picker.
            if (next && next !== posterUrl) setBrandingModalOpen(true);
            setPosterUrl(next);
            markDirty();
          }}
          disabled={!editable || busy}
        />
        {posterUrl && (
          <button
            type="button"
            className={styles.coverBrandingChip}
            onClick={() => setBrandingModalOpen(true)}
            disabled={!editable || busy}
          >
            NAISI logo:{" "}
            <strong>{COVER_BRANDING_LABEL[coverBranding]}</strong>
            <span className={styles.coverBrandingChange}>Change</span>
          </button>
        )}
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Description</h2>
        <BlockEditor
          draftId={event.id}
          storagePrefix="event-images"
          blocks={blocks}
          onChange={(next) => {
            setBlocks(next);
            markDirty();
          }}
          disabled={!editable || busy}
        />
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Food</h2>
        <p className={styles.sectionHint}>
          If there&apos;s food, say what it is in plain language. This shows
          prominently on the public event page so attendees can&apos;t miss it.
        </p>
        <Card padding="lg">
          <div className={styles.fields}>
            <Field
              id="food-text"
              label="What's the food?"
              hint="Leave blank if there's no food at this event."
            >
              <Textarea
                id="food-text"
                value={foodText}
                onChange={(e) => {
                  setFoodText(e.target.value);
                  markDirty();
                }}
                rows={2}
                maxLength={FOOD_TEXT_MAX}
                disabled={!editable || busy}
                placeholder="e.g. Pizza ordered from Domino's Beeston, collected at 6pm"
              />
            </Field>

            <div>
              <span className={styles.checkboxGroupLabel}>Dietary tags (optional)</span>
              <p className={styles.checkboxGroupHint}>
                Tick any that genuinely apply. Shown as badges on the event page.
              </p>
              <div className={styles.tagRow}>
                {FOOD_TAGS.map((tag) => (
                  <label key={tag} className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={dietaryTags.includes(tag)}
                      onChange={(e) => {
                        setDietaryTags((cur) =>
                          e.target.checked
                            ? [...cur, tag]
                            : cur.filter((t) => t !== tag),
                        );
                        markDirty();
                      }}
                      disabled={!editable || busy}
                    />
                    {FOOD_TAG_LABEL[tag]}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </section>

      <section>
        <h2 className={styles.sectionTitle}>Signup questions</h2>
        <p className={styles.sectionHint}>
          Build the booking form for this event. Attendees are always asked their name and
          email — add questions below for everything else (dietary, t-shirt size, etc.).
        </p>
        <FormBuilder
          questions={signupForm}
          onChange={(next) => {
            setSignupForm(next);
            markDirty();
          }}
          disabled={!editable || busy}
        />
      </section>

      {canManageCollaborators && (
        <section>
          <h2 className={styles.sectionTitle}>Who can edit this</h2>
          <p className={styles.sectionHint}>
            Add committee members as collaborators so they can help plan and
            edit this event. They can edit it up until it&apos;s published;
            after that only approvers manage it.
          </p>
          <Card padding="lg">
            <CollaboratorPicker eventId={event.id} />
          </Card>
        </section>
      )}

      {error && <p className={styles.danger}>{error}</p>}
      {publishStatus.kind === "error" && (
        <Card padding="md">
          <p className={styles.danger}>Publish failed: {publishStatus.message}</p>
        </Card>
      )}

      <div className={styles.editorActions}>
        {editable && (
          <Button onClick={onSave} disabled={busy || !dirty || endBeforeStart}>
            {busy ? "Saving…" : "Save"}
          </Button>
        )}

        {editable && status === "published" && (
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={notifyOnSave}
              onChange={(e) => setNotifyOnSave(e.target.checked)}
              disabled={busy}
            />
            Email confirmed attendees about this change
          </label>
        )}

        {canDraft && (status === "draft" || status === "rejected") && isAuthor && (
          <Button
            variant="ghost"
            onClick={onSubmitForReview}
            disabled={busy || endBeforeStart}
          >
            Submit for review
          </Button>
        )}

        {canApprove && status === "pending" && (
          <>
            <Button onClick={onApprove} disabled={busy}>
              Approve
            </Button>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <Input
                id="rejectNote"
                placeholder="Reason to send back for revisions…"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                style={{ minWidth: "16rem" }}
              />
              <Button variant="ghost" onClick={onReject} disabled={busy}>
                Send back
              </Button>
            </div>
          </>
        )}

        {canApprove && status === "approved" && (
          <Button onClick={onPublish} disabled={publishStatus.kind === "publishing"}>
            {publishStatus.kind === "publishing" ? "Publishing…" : "Publish"}
          </Button>
        )}

        {canApprove && (status === "pending" || status === "approved") && (
          <Button variant="ghost" onClick={onRevertToDraft} disabled={busy}>
            Move back to draft
          </Button>
        )}

        {canApprove && status === "published" && (
          <Button variant="ghost" onClick={openCancelModal} disabled={busy}>
            Mark cancelled
          </Button>
        )}

        <div className={styles.spacer} />

        {(isAuthor || role === "admin") && (
          <Button variant="ghost" onClick={onArchive} disabled={busy}>
            {event.archived ? "Unarchive" : "Archive"}
          </Button>
        )}

        {(isAuthor || role === "admin") && status !== "published" && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className={styles.deleteBtn}
          >
            Delete event
          </button>
        )}
      </div>

      {cancelOpen && (
        <div className={styles.modalOverlay} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            {cancelState.kind === "done" ? (
              <>
                <p className={styles.modalTitle}>Event cancelled</p>
                <p className={styles.modalHint}>
                  {cancelState.notified
                    ? cancelState.sent > 0
                      ? `Emailed ${cancelState.sent} attendee${
                          cancelState.sent === 1 ? "" : "s"
                        } about the cancellation.`
                      : "No confirmed or waitlisted attendees to email."
                    : "Attendees were not emailed."}
                </p>
                <div className={styles.modalActions}>
                  <Button onClick={() => setCancelOpen(false)}>Close</Button>
                </div>
              </>
            ) : (
              <>
                <p className={styles.modalTitle}>Cancel this event?</p>
                <p className={styles.modalHint}>
                  This marks the event as cancelled. It stays visible at its
                  link, clearly labelled as cancelled.
                </p>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={cancelNotify}
                    onChange={(e) => setCancelNotify(e.target.checked)}
                    disabled={cancelState.kind === "cancelling"}
                  />
                  Email confirmed and waitlisted attendees that it&apos;s
                  cancelled
                </label>
                <Field
                  id="cancel-note"
                  label="Note to attendees (optional)"
                  hint={
                    cancelNotify
                      ? "Included in the cancellation email - e.g. why it's off, or whether it'll be rescheduled."
                      : "Only sent if you email attendees above."
                  }
                >
                  <Textarea
                    id="cancel-note"
                    value={cancelNote}
                    onChange={(e) => setCancelNote(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    disabled={cancelState.kind === "cancelling"}
                    placeholder="e.g. The venue fell through. We're sorry, and we'll try to reschedule soon."
                  />
                </Field>
                {cancelState.kind === "error" && (
                  <p className={styles.danger}>{cancelState.message}</p>
                )}
                <div className={styles.modalActions}>
                  <Button
                    onClick={onConfirmCancel}
                    disabled={cancelState.kind === "cancelling"}
                  >
                    {cancelState.kind === "cancelling"
                      ? "Cancelling…"
                      : "Cancel event"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setCancelOpen(false)}
                    disabled={cancelState.kind === "cancelling"}
                  >
                    Keep event
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {brandingModalOpen && posterUrl && (
        <CoverBrandingModal
          posterUrl={posterUrl}
          value={coverBranding}
          logoColor={coverLogoColor}
          stripSize={coverStripSize}
          logoPosition={coverLogoPosition}
          logoScale={coverLogoScale}
          logoX={coverLogoX}
          logoY={coverLogoY}
          logoBackdrop={coverLogoBackdrop}
          logoShadow={coverLogoShadow}
          onSelect={(choice) => {
            setCoverBranding(choice.branding);
            setCoverLogoColor(choice.logoColor);
            setCoverStripSize(choice.stripSize);
            setCoverLogoPosition(choice.logoPosition);
            setCoverLogoScale(choice.logoScale);
            setCoverLogoX(choice.logoX);
            setCoverLogoY(choice.logoY);
            setCoverLogoBackdrop(choice.logoBackdrop);
            setCoverLogoShadow(choice.logoShadow);
            markDirty();
          }}
          onClose={() => setBrandingModalOpen(false)}
        />
      )}
    </div>
  );
}
