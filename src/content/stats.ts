/**
 * Stats shown in the homepage's "By the numbers" strip.
 *
 * Edit this file to update numbers. Each value is a string so the
 * DigitRoll component can parse the leading number and treat any suffix
 * (e.g. "+", "K") as a static cap on the rolling barrels.
 *
 * Set value to "" or remove an entry entirely to hide it; if the array
 * ends up empty the StatsRow section hides itself.
 */
export type Stat = {
  /** Display value. Numeric prefix gets the digit-roll tween. */
  value: string;
  /** Short uppercase label below the number. */
  label: string;
};

export const STATS: Stat[] = [
  { value: "30+", label: "Members" },
  { value: "4", label: "Fellowships run" },
  { value: "30+", label: "Events hosted" },
];
