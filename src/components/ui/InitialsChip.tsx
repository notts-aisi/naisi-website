import styles from "./InitialsChip.module.css";

type Props = {
  name: string;
  uid: string;
  size?: "sm" | "md";
};

/** Must match the number of `.hueN` classes in InitialsChip.module.css. */
const HUES = 8;

/**
 * FNV-1a over the uid. Deterministic across renders, devices and sessions, so
 * a member keeps one colour everywhere they appear, and cheap enough to run
 * per roster row. Not a security hash — a collision just means two people
 * share a colour, which the initials disambiguate.
 */
function hueIndex(uid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    hash ^= uid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % HUES;
}

/**
 * First letter of the first and last word. Array.from, not [0], so a name
 * starting with an astral-plane character doesn't render half a code point.
 */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * Initials in a coloured disc, for surfaces that list people (rosters,
 * comments, the allocation board).
 *
 * Decorative by contract: it is `aria-hidden`, so every callsite must render
 * the member's name alongside it — via `MemberName` — rather than leaning on
 * the disc to identify anyone. Two initials are not an identity.
 */
export default function InitialsChip({ name, uid, size = "md" }: Props) {
  const cls = [styles.chip, styles[size], styles[`hue${hueIndex(uid)}`]].join(" ");
  return (
    <span className={cls} title={name} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
