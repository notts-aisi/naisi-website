"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { sendEmailVerification } from "firebase/auth";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ActionToast, { useActionToast } from "@/components/ui/ActionToast";
import CollaboratorApplicationForm from "@/components/CollaboratorApplicationForm";
import { useAuth } from "@/auth/AuthProvider";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import {
  normalizeCollaborator,
  type CollaboratorDoc,
  type CollaboratorInput,
} from "@/lib/firestore/collaborators";

const STATUS_BADGE: Record<
  CollaboratorDoc["status"],
  { tone: "neutral" | "accent" | "success" | "danger"; label: string }
> = {
  pending: { tone: "accent", label: "Under review" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "danger", label: "Not approved" },
};

export default function CollaboratorAreaPage() {
  const { user, loading: authLoading } = useAuth();
  const [doc, setDoc] = useState<CollaboratorDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast, run, dismiss } = useActionToast();
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  // Live email-verification status. user.emailVerified is cached on the client
  // and only updates on reload(), so the banner used to need a manual page
  // refresh. null = not yet checked; true/false = the live value.
  const [verified, setVerified] = useState<boolean | null>(null);

  // Subscribe to the caller's own collaborators doc. The doc id is name-slugged,
  // so query the `uid` field (rules allow reading docs where uid == auth.uid).
  useEffect(() => {
    if (!user) return;
    const db = getClientDb();
    const q = query(collection(db, "collaborators"), where("uid", "==", user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const first = snap.docs[0];
        setDoc(first ? normalizeCollaborator(first.id, first.data()) : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
    return unsub;
  }, [user]);

  // Refresh the Firebase user so emailVerified flips without a manual reload:
  // immediately from cache, then again whenever the user returns to the page
  // (so coming back from the email-verification link updates the card itself).
  useEffect(() => {
    if (!user) return;
    let active = true;
    let isVerified = false;
    const apply = (v: boolean) => {
      isVerified = v;
      if (active) setVerified(v);
    };
    const refresh = async () => {
      if (!active || isVerified) return;
      const current = getClientAuth().currentUser;
      if (!current) return;
      apply(current.emailVerified); // immediate, from cache
      try {
        await current.reload();
      } catch {
        return;
      }
      if (active) apply(current.emailVerified); // fresh, post-reload
    };
    // emailVerified is Firebase Auth state, NOT a Firestore field (we don't
    // mirror it — the live-verification decision), so there's no onSnapshot to
    // subscribe to and Auth exposes no realtime listener for it. Rather than poll
    // reload() forever, refresh on mount and whenever the user returns to the
    // page: `focus` covers coming back from another window/app, and
    // `visibilitychange` covers switching back from a sibling tab in the same
    // window (e.g. the verification link opened in a new tab).
    const onWake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    void refresh();
    return () => {
      active = false;
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [user]);

  async function handleSave(input: CollaboratorInput) {
    await run(
      async () => {
        const res = await fetch("/api/collaborators", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(body?.error ?? "Couldn't save your changes.");
      },
      { savingMessage: "Saving changes…", successMessage: "Changes saved" },
    );
  }

  async function resendVerification() {
    const current = getClientAuth().currentUser;
    if (!current) return;
    try {
      await sendEmailVerification(current);
      setVerifyNote("Verification email sent. Check your inbox.");
    } catch {
      setVerifyNote("Couldn't send right now. Try again in a moment.");
    }
  }

  if (authLoading || loading) {
    return (
      <Card padding="lg" style={{ width: "100%" }}>
        <p style={{ color: "var(--color-text-muted)" }}>Loading…</p>
      </Card>
    );
  }

  const status = doc?.status ?? "pending";
  const badge = STATUS_BADGE[status];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <Card padding="lg" style={{ width: "100%" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            flexWrap: "wrap",
          }}
        >
          <h1 style={{ fontSize: "var(--text-2xl)", margin: 0 }}>Your application</h1>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)", marginBottom: 0 }}>
          {status === "pending" &&
            "Thanks for applying to collaborate with NAISI. The team is reviewing your application, and we'll email you when there's an update. You can refine it below any time."}
          {status === "approved" &&
            "Your application has been approved. We'll be in touch with next steps, so keep an eye on your inbox."}
          {status === "rejected" &&
            "We weren't able to move forward with your application this time. You're welcome to update it below."}
        </p>
        {status === "rejected" && doc?.rejectionReason && (
          <p
            style={{
              marginTop: "var(--space-3)",
              padding: "var(--space-3)",
              borderRadius: "var(--radius-md)",
              background: "var(--color-bg-elevated)",
              color: "var(--color-text)",
              fontSize: "var(--text-sm)",
            }}
          >
            {doc.rejectionReason}
          </p>
        )}
      </Card>

      {verified === false && (
        <Card padding="md" style={{ width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-3)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
              Your email isn&apos;t verified yet. Check your inbox for the link we sent.
            </span>
            <Button variant="secondary" size="sm" onClick={resendVerification}>
              Resend verification
            </Button>
          </div>
          {verifyNote && (
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)", marginBottom: 0 }}>
              {verifyNote}
            </p>
          )}
        </Card>
      )}

      {verified === true && (
        <Card padding="md" style={{ width: "100%" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              color: "var(--color-success)",
              fontSize: "var(--text-sm)",
              fontWeight: 500,
            }}
          >
            <span aria-hidden="true">✓</span> Your email address is verified.
          </span>
        </Card>
      )}

      <Card padding="lg" style={{ width: "100%" }}>
        {doc ? (
          <CollaboratorApplicationForm
            initial={{ fullName: doc.fullName, application: doc.application }}
            submitLabel="Save changes"
            busyLabel="Saving…"
            busy={toast?.phase === "saving"}
            onSubmit={handleSave}
          />
        ) : (
          <p style={{ color: "var(--color-text-muted)" }}>
            We couldn&apos;t find your application. If you just signed up, please
            re-open the apply link.
          </p>
        )}
      </Card>

      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
}
