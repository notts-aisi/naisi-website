"use client";

import { useState, type ReactNode } from "react";
import { Field, Input } from "@/components/ui/Input";
import CountedTextarea from "@/components/ui/CountedTextarea";
import Switch from "@/components/ui/Switch";
import Button from "@/components/ui/Button";
import PolicyConsent from "@/components/PolicyConsent";
import {
  COLLABORATOR_FIELD_LIMITS as L,
  validateCollaboratorInput,
  type CollaboratorInput,
} from "@/lib/firestore/collaborators";

/**
 * The external-collaborator application form. Shared between the apply flow
 * (/register?type=collaborator) and the collaborator area (edit). Holds its own
 * field state seeded from `initial`, validates with the same
 * `validateCollaboratorInput` the server route uses, and hands a clean
 * `CollaboratorInput` to `onSubmit`. The parent owns the async + any server error.
 */
export default function CollaboratorApplicationForm({
  initial,
  submitLabel,
  busyLabel,
  busy = false,
  disabled = false,
  externalError = null,
  onSubmit,
  intro,
  requireConsent = false,
}: {
  initial?: Partial<CollaboratorInput> & { application?: Partial<CollaboratorInput["application"]> };
  submitLabel: string;
  busyLabel: string;
  busy?: boolean;
  /** Hard-disable the submit (e.g. site notice pausing applications) without
      the busy label — the parent renders the explanatory copy. */
  disabled?: boolean;
  externalError?: string | null;
  onSubmit: (input: CollaboratorInput) => void | Promise<void>;
  intro?: ReactNode;
  /** Show + require the Terms/Privacy consent checkbox (apply flow, not edit). */
  requireConsent?: boolean;
}) {
  const a0 = initial?.application;
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [projectPitch, setProjectPitch] = useState(a0?.projectPitch ?? "");
  const [background, setBackground] = useState(a0?.background ?? "");
  const [institution, setInstitution] = useState(a0?.institution ?? "");
  const [roleTitle, setRoleTitle] = useState(a0?.roleTitle ?? "");
  const [interests, setInterests] = useState(a0?.interests ?? "");
  const [heardAbout, setHeardAbout] = useState(a0?.heardAbout ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(a0?.linkedinUrl ?? "");
  const [portfolioUrl, setPortfolioUrl] = useState(a0?.portfolioUrl ?? "");
  const [knowsCommittee, setKnowsCommittee] = useState(a0?.knowsCommittee ?? false);
  const [committeeContactName, setCommitteeContactName] = useState(
    a0?.committeeContactName ?? "",
  );
  const [impactJustification, setImpactJustification] = useState(
    a0?.impactJustification ?? "",
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const input: CollaboratorInput = {
      fullName,
      application: {
        projectPitch,
        background,
        institution,
        roleTitle,
        interests,
        heardAbout,
        knowsCommittee,
        linkedinUrl: linkedinUrl || undefined,
        portfolioUrl: portfolioUrl || undefined,
        committeeContactName: committeeContactName || undefined,
        impactJustification: impactJustification || undefined,
      },
    };
    const err = validateCollaboratorInput(input);
    if (err) {
      setLocalError(err);
      return;
    }
    if (requireConsent && !agreed) {
      setLocalError("Please agree to the Terms of Use and Privacy Policy to continue.");
      return;
    }
    void onSubmit(input);
  }

  const error = localError ?? externalError;

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
    >
      {intro}

      <Field id="collab-name" label="Your name">
        <Input
          id="collab-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          maxLength={L.fullName}
          placeholder="First and last name"
          required
        />
      </Field>

      <Field
        id="collab-pitch"
        label="What would you like to work on with us?"
        hint="Your proposed project or collaboration: what you'd do, and why with NAISI."
      >
        <CountedTextarea
          id="collab-pitch"
          value={projectPitch}
          onChange={(e) => setProjectPitch(e.target.value)}
          max={L.projectPitch}
          rows={5}
          required
        />
      </Field>

      <Field
        id="collab-background"
        label="Your background"
        hint="A short bio: your research, experience, and what you bring."
      >
        <CountedTextarea
          id="collab-background"
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          max={L.background}
          rows={4}
          required
        />
      </Field>

      <Field id="collab-institution" label="Institution / affiliation">
        <Input
          id="collab-institution"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          maxLength={L.institution}
          placeholder="University, lab, company, or independent"
          required
        />
      </Field>

      <Field id="collab-role" label="Your role or title">
        <Input
          id="collab-role"
          value={roleTitle}
          onChange={(e) => setRoleTitle(e.target.value)}
          maxLength={L.roleTitle}
          placeholder="e.g. PhD student, research engineer, independent researcher"
          required
        />
      </Field>

      <Field
        id="collab-interests"
        label="Areas of AI safety interest"
        hint="e.g. interpretability, alignment, governance, evals."
      >
        <CountedTextarea
          id="collab-interests"
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          max={L.interests}
          rows={2}
          required
        />
      </Field>

      <Field id="collab-linkedin" label="LinkedIn (optional)">
        <Input
          id="collab-linkedin"
          type="url"
          value={linkedinUrl}
          onChange={(e) => setLinkedinUrl(e.target.value)}
          maxLength={L.linkedinUrl}
          placeholder="https://www.linkedin.com/in/…"
        />
      </Field>

      <Field id="collab-portfolio" label="Portfolio / personal website (optional)">
        <Input
          id="collab-portfolio"
          type="url"
          value={portfolioUrl}
          onChange={(e) => setPortfolioUrl(e.target.value)}
          maxLength={L.portfolioUrl}
          placeholder="https://…"
        />
      </Field>

      <Field id="collab-heard" label="How did you hear about NAISI?">
        <Input
          id="collab-heard"
          value={heardAbout}
          onChange={(e) => setHeardAbout(e.target.value)}
          maxLength={L.heardAbout}
          placeholder="A referral, an event, social media, …"
          required
        />
      </Field>

      <fieldset
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <Switch
          checked={knowsCommittee}
          onChange={setKnowsCommittee}
          label="Do you know anyone on the NAISI committee?"
        />
        {knowsCommittee && (
          <Field id="collab-contact" label="Who?">
            <Input
              id="collab-contact"
              value={committeeContactName}
              onChange={(e) => setCommitteeContactName(e.target.value)}
              maxLength={L.committeeContactName}
              placeholder="Their name"
              required
            />
          </Field>
        )}
      </fieldset>

      <Field
        id="collab-impact"
        label="Why would you be a high-impact collaborator? (optional)"
        hint="Optional. Anything that helps us understand the potential of working together."
      >
        <CountedTextarea
          id="collab-impact"
          value={impactJustification}
          onChange={(e) => setImpactJustification(e.target.value)}
          max={L.impactJustification}
          rows={3}
        />
      </Field>

      {requireConsent && (
        <PolicyConsent checked={agreed} onChange={setAgreed} id="collab-consent" />
      )}

      {error && (
        <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }}>{error}</p>
      )}

      <Button type="submit" fullWidth size="lg" disabled={busy || disabled}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}
