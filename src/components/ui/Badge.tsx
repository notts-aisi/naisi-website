import type { HTMLAttributes, ReactNode } from "react";
import Chip, { type ChipTone } from "./Chip";

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: ChipTone;
  children: ReactNode;
};

/**
 * Thin alias for `<Chip size="md">`. Chip's `md` rules are Badge's former
 * inline styles verbatim, so every existing callsite renders identically —
 * including the ~23 that pass a `style` override, since inline styles still
 * win over Chip's classes.
 *
 * New code should reach for Chip directly (it has the size axis and the
 * hover/focus states); Badge stays so this refactor costs zero callsite churn.
 */
export default function Badge({ tone = "neutral", children, ...rest }: Props) {
  return (
    <Chip tone={tone} size="md" {...rest}>
      {children}
    </Chip>
  );
}
