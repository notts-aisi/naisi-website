import {
  answerMaxLength,
  DIETARY_ALLERGIES,
  DIETARY_NONE,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";

export type ValidateAnswersOptions = {
  /**
   * Refuse a form that leaves a required question blank. Default true, which
   * is what every submit path wants.
   *
   * A DRAFT save passes false. A saved-but-unsubmitted application is allowed
   * to be half written by definition, so refusing it on a required question
   * would mean the applicant could not save until they had finished, which is
   * the opposite of what a draft is for. Everything else stays enforced on a
   * draft: an unknown option, an answer over its character limit and a
   * malformed shape are all still refused, so a draft can never hold a value
   * that the submit path would then have to reject.
   */
  enforceRequired?: boolean;
};

export type ValidateAnswersResult =
  | { answers: Record<string, RsvpAnswer> }
  | { error: string; questionId: string };

/**
 * Validate and coerce a raw answers payload against a signup or application
 * form. Returns `{ answers }` if every question is answered with a well-typed
 * value inside its character limit, or `{ error, questionId }` with the first
 * problem found. `questionId` lets a form render the message against the field
 * rather than only at the top.
 *
 * Runs server-side in the RSVP and application routes: clients can send
 * anything, so don't trust the shape.
 *
 * Character limits are per question via `answerMaxLength`, which falls back to
 * 500 when the question carries no `maxLength`. Every form authored before
 * per-question limits existed is stored without the key, so those forms refuse
 * at exactly the same length they always did.
 */
export function validateAnswers(
  questions: FormQuestion[],
  raw: unknown,
  options: ValidateAnswersOptions = {},
): ValidateAnswersResult {
  const enforceRequired = options.enforceRequired !== false;

  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { error: "Answers must be an object.", questionId: "" };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, RsvpAnswer> = {};

  for (const q of questions) {
    const v = input[q.id];
    const limit = answerMaxLength(q);
    const missing = () => ({ error: `"${q.label}" is required.`, questionId: q.id });
    const tooLong = () => ({
      error: `"${q.label}" is too long (max ${limit} chars).`,
      questionId: q.id,
    });
    const unknownOption = () => ({
      error: `"${q.label}" has an unknown option.`,
      questionId: q.id,
    });
    const badShape = () => ({
      error: `"${q.label}" has an invalid shape.`,
      questionId: q.id,
    });

    if (q.type === "shortText" || q.type === "longText") {
      const s = typeof v === "string" ? v.trim() : "";
      if (enforceRequired && q.required && !s) return missing();
      if (s.length > limit) return tooLong();
      if (s) out[q.id] = s;
      continue;
    }

    if (q.type === "singleSelect") {
      const allowed = q.options.map((o) => o.trim()).filter(Boolean);
      const s = typeof v === "string" ? v.trim() : "";
      if (enforceRequired && q.required && !s) return missing();
      if (s && !allowed.includes(s)) return unknownOption();
      if (s) out[q.id] = s;
      continue;
    }

    if (q.type === "multiSelect") {
      const allowed = q.options.map((o) => o.trim()).filter(Boolean);
      if (q.noneOption) allowed.push(q.noneOption);

      // A question with an "Other" box or a "none" option sends
      // { checked, other }; a plain multi-select sends a string[].
      if (q.allowOther || q.noneOption) {
        if (v === undefined || v === null) {
          if (enforceRequired && q.required) return missing();
          continue;
        }
        if (typeof v !== "object" || Array.isArray(v)) return badShape();
        const obj = v as Record<string, unknown>;
        const checked = Array.isArray(obj.checked)
          ? (obj.checked as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const dedup = Array.from(new Set(checked.map((s) => s.trim()).filter(Boolean)));
        for (const x of dedup) {
          if (!allowed.includes(x)) return unknownOption();
        }
        const other =
          q.allowOther && typeof obj.other === "string" ? obj.other.trim() : "";
        if (other.length > limit) {
          return {
            error: `"${q.label}" other-field is too long (max ${limit}).`,
            questionId: q.id,
          };
        }
        if (enforceRequired && q.required && dedup.length === 0 && !other) {
          return missing();
        }
        if (dedup.length > 0 || other) {
          out[q.id] = { checked: dedup, other };
        }
        continue;
      }

      const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const dedup = Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
      for (const x of dedup) {
        if (!allowed.includes(x)) return unknownOption();
      }
      if (enforceRequired && q.required && dedup.length === 0) return missing();
      if (dedup.length > 0) out[q.id] = dedup;
      continue;
    }

    if (q.type === "yesNo") {
      if (typeof v === "boolean") {
        out[q.id] = v;
      } else if (enforceRequired && q.required) {
        return missing();
      }
      continue;
    }

    if (q.type === "dietaryAllergies") {
      if (v === undefined || v === null) {
        if (enforceRequired && q.required) return missing();
        continue;
      }
      if (typeof v !== "object" || Array.isArray(v)) return badShape();
      const obj = v as Record<string, unknown>;
      const checked = Array.isArray(obj.checked)
        ? (obj.checked as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const dedup = Array.from(new Set(checked));
      for (const x of dedup) {
        if (!DIETARY_ALLERGIES.includes(x) && x !== DIETARY_NONE) {
          return {
            error: `"${q.label}" has an unknown allergy option.`,
            questionId: q.id,
          };
        }
      }
      const other = typeof obj.other === "string" ? obj.other.trim() : "";
      if (other.length > limit) {
        return {
          error: `"${q.label}" other-field is too long (max ${limit}).`,
          questionId: q.id,
        };
      }
      if (enforceRequired && q.required && dedup.length === 0 && !other) {
        return missing();
      }
      if (dedup.length > 0 || other) {
        out[q.id] = { checked: dedup, other };
      }
      continue;
    }
  }

  return { answers: out };
}
