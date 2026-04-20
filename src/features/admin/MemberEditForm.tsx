"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CountedTextarea from "@/components/ui/CountedTextarea";
import GraduationSelect from "@/components/ui/GraduationSelect";
import StatusSelect from "@/components/ui/StatusSelect";
import { Field, Input } from "@/components/ui/Input";
import {
  FIELD_LIMITS,
  STATUSES_WITH_GRADUATION,
  subjectLabel,
  type AffiliationStatus,
  type UserDoc,
} from "@/lib/firestore/users";
import { updateMember, updateUserProfile } from "./adminMutations";

type Props = {
  user: UserDoc;
  onDone: () => void;
};

export default function MemberEditForm({ user, onDone }: Props) {
  const [preferredName, setPreferredName] = useState(user.profile?.preferredName ?? "");
  const [universityEmail, setUniversityEmail] = useState(user.profile?.universityEmail ?? "");
  const [status, setStatus] = useState<AffiliationStatus | "">(user.profile?.status ?? "");
  const [statusOther, setStatusOther] = useState(user.profile?.statusOther ?? "");
  const [subject, setSubject] = useState(
    user.profile?.subject ?? user.profile?.course ?? "",
  );
  const [expectedGraduation, setExpectedGraduation] = useState(
    user.profile?.expectedGraduation ?? "",
  );
  const [motivation, setMotivation] = useState(user.profile?.motivation ?? "");
  const [interests, setInterests] = useState(user.profile?.interests ?? "");
  const [title, setTitle] = useState(user.title ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showGraduation = status !== "" && STATUSES_WITH_GRADUATION.includes(status);
  const showStatusOther = status === "other";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await Promise.all([
        updateUserProfile(user.uid, {
          preferredName: preferredName.trim(),
          universityEmail: universityEmail.trim(),
          status: status || undefined,
          statusOther: showStatusOther ? statusOther.trim() : "",
          subject: subject.trim(),
          expectedGraduation: showGraduation ? expectedGraduation : "",
          motivation: motivation.trim(),
          interests: interests.trim(),
        }),
        updateMember(user.uid, {
          title: title.trim() || null,
          bio: bio.trim() || null,
        }),
      ]);
      onDone();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg">
      <h3 style={{ fontSize: "var(--text-lg)", marginBottom: "var(--space-1)" }}>
        Edit {user.displayName ?? user.email}
      </h3>
      <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)", marginBottom: "var(--space-5)" }}>
        Changes save to Firestore immediately.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "grid", gap: "var(--space-4)", gridTemplateColumns: "1fr 1fr" }}>
        <Field id={`pn-${user.uid}`} label="Preferred name">
          <Input
            id={`pn-${user.uid}`}
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            maxLength={FIELD_LIMITS.preferredName}
          />
        </Field>
        <Field id={`uni-${user.uid}`} label="University email">
          <Input
            id={`uni-${user.uid}`}
            type="email"
            value={universityEmail}
            onChange={(e) => setUniversityEmail(e.target.value)}
            placeholder="you@nottingham.ac.uk"
            maxLength={FIELD_LIMITS.universityEmail}
          />
        </Field>
        <Field id={`status-${user.uid}`} label="What do you do at UoN?">
          <StatusSelect id={`status-${user.uid}`} value={status} onChange={setStatus} />
        </Field>
        <Field id={`subject-${user.uid}`} label={subjectLabel(status || undefined)}>
          <Input
            id={`subject-${user.uid}`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={FIELD_LIMITS.subject}
          />
        </Field>
        {showStatusOther && (
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id={`statusOther-${user.uid}`} label="Describe role (Other)">
              <Input
                id={`statusOther-${user.uid}`}
                value={statusOther}
                onChange={(e) => setStatusOther(e.target.value)}
                maxLength={FIELD_LIMITS.statusOther}
              />
            </Field>
          </div>
        )}
        {showGraduation && (
          <div style={{ gridColumn: "1 / -1" }}>
            <Field id={`grad-${user.uid}`} label="Expected graduation">
              <GraduationSelect
                id={`grad-${user.uid}`}
                value={expectedGraduation}
                onChange={setExpectedGraduation}
              />
            </Field>
          </div>
        )}
        <Field
          id={`title-${user.uid}`}
          label="Committee title"
          hint="Shown on the public Members page (e.g. President, Treasurer)."
        >
          <Input
            id={`title-${user.uid}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={FIELD_LIMITS.title}
          />
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field id={`motivation-${user.uid}`} label="Motivation">
            <CountedTextarea
              id={`motivation-${user.uid}`}
              value={motivation}
              onChange={(e) => setMotivation(e.target.value)}
              max={FIELD_LIMITS.motivation}
              rows={3}
            />
          </Field>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field
            id={`interests-${user.uid}`}
            label="AI safety interests"
            hint="Optional — interpretability, alignment, governance, etc."
          >
            <CountedTextarea
              id={`interests-${user.uid}`}
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              max={FIELD_LIMITS.interests}
              rows={2}
            />
          </Field>
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field id={`bio-${user.uid}`} label="Public bio" hint="Shown on the public Members page.">
            <CountedTextarea
              id={`bio-${user.uid}`}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              max={FIELD_LIMITS.bio}
              rows={3}
            />
          </Field>
        </div>

        {error && (
          <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)", gridColumn: "1 / -1" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: "var(--space-3)", gridColumn: "1 / -1" }}>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
