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
 * carry a mix that clusters like real signups - popular toppings are avoided
 * by many people, rarer ones by a few - so the charts and the pizza helper
 * get a realistic spread of overlapping groups to work with.
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

/**
 * Dislike rate for the multi-select option at `index` of `total`. It steps
 * down the list - the first option is widely avoided, the last only rarely -
 * so independent per-option rolls produce overlapping clusters of varying
 * size rather than a scatter of one-off picks.
 */
function optionDislikeRate(index: number, total: number): number {
  const HIGH = 0.45;
  const LOW = 0.1;
  if (total <= 1) return HIGH;
  return HIGH - (index / (total - 1)) * (HIGH - LOW);
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
        // Roll each option independently against its own dislike rate, so the
        // popular options cluster (many people share them) while the rare ones
        // form small groups - the spread the pizza helper is built to handle.
        const checked: string[] =
          hasRequirements && opts.length > 0
            ? opts.filter((_, i) => chance(optionDislikeRate(i, opts.length)))
            : [];
        if (q.allowOther || q.noneOption) {
          const other =
            hasRequirements && q.allowOther && chance(0.15)
              ? pick(OTHER_TOPPINGS)
              : "";
          // Mark "none" only when there is genuinely nothing flagged.
          const finalChecked =
            checked.length === 0 && other === "" && q.noneOption
              ? [q.noneOption]
              : checked;
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
