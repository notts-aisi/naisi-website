import { FOOD_PROVENANCE_BADGE, type EventDoc } from "@/lib/firestore/events";

/**
 * What an event's food line says on a public surface, decided once.
 *
 * `foodText` is the field an organiser fills in today. The two `provenance`
 * fields behind it are the deprecated pair that published events from before
 * the food declaration was rewritten still carry, and an old event has only
 * those, so the fallback is what keeps its food line on the page at all.
 *
 * It lives here rather than inside a component because two public surfaces
 * print it now, the event page and the add-to-calendar page, and a derivation
 * copied into the second one is a derivation that drifts from the first.
 */
export function publicFoodLine(event: EventDoc): string | null {
  const text = event.foodText?.trim();
  if (text) return text;
  if (event.foodProvenance === "none") return null;
  const badge = FOOD_PROVENANCE_BADGE[event.foodProvenance];
  const note = event.foodProvenanceNote?.trim();
  return note ? `${badge}: ${note}` : badge;
}
