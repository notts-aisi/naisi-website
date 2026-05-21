import {
  DIETARY_ALLERGIES,
  DIETARY_NONE,
  type FormQuestion,
  type RsvpAnswer,
} from "@/lib/firestore/events";

/**
 * Generates random, well-shaped answers for an event's signup form so an
 * organiser can trial a full RSVP flow before publishing, without entering
 * signups by hand. Used only by the admin-only /api/events/[id]/test-rsvps
 * route; every doc it produces is tagged `synthetic: true`.
 *
 * Roughly one in three generated attendees has nothing to flag; the rest
 * carry a random mix, so both the empty and the populated displays (catering
 * notes, charts, the pizza helper) get exercised.
 */

const FIRST_NAMES = [
  "Amelia", "Oliver", "Priya", "Marcus", "Sofia", "Daniel", "Aisha", "Tom",
  "Yara", "Ethan", "Mei", "Joshua", "Fatima", "Leo", "Hannah", "Noah",
  "Zainab", "Charlie", "Grace", "Idris", "Lucy", "Samuel", "Nadia", "Ben",
  "Chloe", "Raj", "Erin", "Felix",
];

const LAST_NAMES = [
  "Patel", "Smith", "Okafor", "Nguyen", "Jones", "Hassan", "Walsh", "Khan",
  "Brown", "Adeyemi", "Taylor", "Lin", "Murphy", "Kaur", "Evans", "Costa",
  "Ahmed", "Wright",
];

const NOTES = [
  "Might be about ten minutes late.",
  "Bringing a friend along, hope that's ok.",
  "Could you confirm the room number?",
  "Looking forward to it.",
  "No onions for me, please.",
];

const OTHER_TOPPINGS = ["Sweetcorn", "Jalapenos", "Extra chilli"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chance(p: number): boolean {
  return Math.random() < p;
}

/** A random selection of between `min` and `max` distinct items from `arr`. */
function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const pool = [...arr];
  const target = Math.min(pool.length, min + Math.floor(Math.random() * (max - min + 1)));
  const out: T[] = [];
  for (let i = 0; i < target && pool.length > 0; i++) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

export type SyntheticRsvp = {
  name: string;
  email: string;
  answers: Record<string, RsvpAnswer>;
};

/** Build one random test RSVP for the given signup form. */
export function buildSyntheticRsvp(questions: FormQuestion[]): SyntheticRsvp {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const rand = Math.random().toString(36).slice(2, 7);

  // One in three has nothing to flag; the rest carry a random mix.
  const hasRequirements = !chance(1 / 3);
  const answers: Record<string, RsvpAnswer> = {};

  for (const q of questions) {
    switch (q.type) {
      case "shortText":
      case "longText": {
        if (hasRequirements && chance(0.5)) answers[q.id] = pick(NOTES);
        else if (q.required) answers[q.id] = "Nothing to add.";
        break;
      }
      case "singleSelect": {
        const opts = q.options.map((o) => o.trim()).filter(Boolean);
        if (opts.length > 0) answers[q.id] = pick(opts);
        break;
      }
      case "multiSelect": {
        const opts = q.options.map((o) => o.trim()).filter(Boolean);
        const checked =
          hasRequirements && opts.length > 0
            ? randomSubset(opts, 1, Math.min(3, opts.length))
            : [];
        if (q.allowOther || q.noneOption) {
          const finalChecked =
            checked.length === 0 && q.noneOption ? [q.noneOption] : checked;
          const other =
            hasRequirements && q.allowOther && chance(0.15)
              ? pick(OTHER_TOPPINGS)
              : "";
          answers[q.id] = { checked: finalChecked, other };
        } else if (checked.length > 0) {
          answers[q.id] = checked;
        }
        break;
      }
      case "yesNo": {
        answers[q.id] = hasRequirements;
        break;
      }
      case "dietaryAllergies": {
        answers[q.id] = hasRequirements
          ? { checked: randomSubset(DIETARY_ALLERGIES, 1, 2), other: "" }
          : { checked: [DIETARY_NONE], other: "" };
        break;
      }
    }
  }

  return {
    name: `${first} ${last}`,
    email: `${first}.${last}.${rand}@example.com`.toLowerCase(),
    answers,
  };
}
