import {
  DIETARY_ALLERGIES,
  DIETARY_NONE,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";

/**
 * Validate and coerce a raw answers payload against the event's signup form.
 * Returns `{ answers }` if every required question is answered with a
 * well-typed value, or `{ error }` with the first problem found.
 *
 * Runs server-side in the RSVP API route — clients can send anything, so
 * don't trust the shape.
 */
export function validateAnswers(
  questions: FormQuestion[],
  raw: unknown,
): { answers: Record<string, RsvpAnswer> } | { error: string } {
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { error: "Answers must be an object." };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, RsvpAnswer> = {};

  for (const q of questions) {
    const v = input[q.id];

    if (q.type === "shortText" || q.type === "longText") {
      const s = typeof v === "string" ? v.trim() : "";
      if (q.required && !s) return { error: `"${q.label}" is required.` };
      if (s.length > 500) return { error: `"${q.label}" is too long (max 500 chars).` };
      if (s) out[q.id] = s;
      continue;
    }

    if (q.type === "singleSelect") {
      const allowed = q.options.map((o) => o.trim()).filter(Boolean);
      const s = typeof v === "string" ? v.trim() : "";
      if (q.required && !s) return { error: `"${q.label}" is required.` };
      if (s && !allowed.includes(s)) return { error: `"${q.label}" has an unknown option.` };
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
          if (q.required) return { error: `"${q.label}" is required.` };
          continue;
        }
        if (typeof v !== "object" || Array.isArray(v)) {
          return { error: `"${q.label}" has an invalid shape.` };
        }
        const obj = v as Record<string, unknown>;
        const checked = Array.isArray(obj.checked)
          ? (obj.checked as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const dedup = Array.from(new Set(checked.map((s) => s.trim()).filter(Boolean)));
        for (const x of dedup) {
          if (!allowed.includes(x)) return { error: `"${q.label}" has an unknown option.` };
        }
        const other =
          q.allowOther && typeof obj.other === "string" ? obj.other.trim() : "";
        if (other.length > 500) {
          return { error: `"${q.label}" other-field is too long (max 500).` };
        }
        if (q.required && dedup.length === 0 && !other) {
          return { error: `"${q.label}" is required.` };
        }
        if (dedup.length > 0 || other) {
          out[q.id] = { checked: dedup, other };
        }
        continue;
      }

      const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const dedup = Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
      for (const x of dedup) {
        if (!allowed.includes(x)) return { error: `"${q.label}" has an unknown option.` };
      }
      if (q.required && dedup.length === 0) return { error: `"${q.label}" is required.` };
      if (dedup.length > 0) out[q.id] = dedup;
      continue;
    }

    if (q.type === "yesNo") {
      if (typeof v === "boolean") {
        out[q.id] = v;
      } else if (q.required) {
        return { error: `"${q.label}" is required.` };
      }
      continue;
    }

    if (q.type === "dietaryAllergies") {
      if (v === undefined || v === null) {
        if (q.required) return { error: `"${q.label}" is required.` };
        continue;
      }
      if (typeof v !== "object" || Array.isArray(v)) {
        return { error: `"${q.label}" has an invalid shape.` };
      }
      const obj = v as Record<string, unknown>;
      const checked = Array.isArray(obj.checked)
        ? (obj.checked as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const dedup = Array.from(new Set(checked));
      for (const x of dedup) {
        if (!DIETARY_ALLERGIES.includes(x) && x !== DIETARY_NONE) {
          return { error: `"${q.label}" has an unknown allergy option.` };
        }
      }
      const other = typeof obj.other === "string" ? obj.other.trim() : "";
      if (other.length > 500) {
        return { error: `"${q.label}" other-field is too long (max 500).` };
      }
      if (q.required && dedup.length === 0 && !other) {
        return { error: `"${q.label}" is required.` };
      }
      if (dedup.length > 0 || other) {
        out[q.id] = { checked: dedup, other };
      }
      continue;
    }
  }

  return { answers: out };
}
