"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./TypedHeadline.module.css";

type Props = {
  /** Typed once as a blur-rise word stagger, then static. */
  prefix?: string;
  /** Typed char-by-char, underlined, deleted, looped. */
  accent?: string;
  /** Delay before the prefix's first word starts revealing. */
  startDelayMs?: number;
};

type Phase =
  | "idle"
  | "typingAccent"
  | "underlining"
  | "holding"
  | "ununderlining"
  | "deleting"
  | "pauseEmpty";

const ACCENT_TYPE_FIRST_MS = 45; // first iteration types faster
const ACCENT_TYPE_LOOP_MS = 70; // looped iterations slower
const ACCENT_DELETE_MS = 40;
const HOLD_MS = 2500;
const PRE_UNDERLINE_MS = 300;
const UN_UNDERLINE_MS = 250;
const POST_DELETE_MS = 600;

/*
  TypedHeadline owns the whole hero headline timeline.

  Prefix: split into words, each animates a blur-rise via CSS keyframe with
  staggered delay. Lands once, stays static.

  Accent: typed char-by-char by a setTimeout chain. Underline grows via CSS
  class toggle. After the first iteration the loop only deletes and re-types.

  Side effect: sets data-loaded="true" on its closest .heroInner ancestor
  after mount, which CSS uses to animate the emblem, eyebrow, lede, and
  CTAs in alongside the typing.
*/
export default function TypedHeadline({
  prefix = "Make AI go well.",
  accent = "From Nottingham.",
  startDelayMs = 500,
}: Props) {
  const [accentText, setAccentText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [underlineState, setUnderlineState] = useState<"hidden" | "growing" | "full" | "shrinking">("hidden");
  const [reduced, setReduced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const firstTypePass = useRef(true);
  const rootRef = useRef<HTMLHeadingElement>(null);

  // Honor reduced motion + mark the hero-inner as loaded so CSS keyframes can fire.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reducedMatch = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReduced(reducedMatch);
    setLoaded(true);

    // Walk up to the .heroInner ancestor and mark it loaded so CSS keyframes fire.
    let node: HTMLElement | null = rootRef.current;
    while (node && !node.dataset.heroInner) node = node.parentElement;
    if (node) node.dataset.loaded = "true";
  }, []);

  // Drive the accent timeline.
  useEffect(() => {
    if (!loaded || reduced) return;

    // Wait for the prefix word-stagger to finish, then begin typing the accent.
    const prefixWordCount = prefix.split(/\s+/).filter(Boolean).length;
    const prefixDoneAt = startDelayMs + 700 + (prefixWordCount - 1) * 120 + 200;

    const start = window.setTimeout(() => {
      setPhase("typingAccent");
    }, prefixDoneAt);

    return () => window.clearTimeout(start);
  }, [loaded, reduced, prefix, startDelayMs]);

  // Phase machine.
  useEffect(() => {
    if (!loaded || reduced) return;
    let timer = 0;

    if (phase === "typingAccent") {
      if (accentText.length < accent.length) {
        const interval = firstTypePass.current ? ACCENT_TYPE_FIRST_MS : ACCENT_TYPE_LOOP_MS;
        timer = window.setTimeout(() => {
          setAccentText(accent.slice(0, accentText.length + 1));
        }, interval + (Math.random() * 20 - 10));
      } else {
        timer = window.setTimeout(() => setPhase("underlining"), PRE_UNDERLINE_MS);
      }
    } else if (phase === "underlining") {
      setUnderlineState("growing");
      timer = window.setTimeout(() => {
        setUnderlineState("full");
        setPhase("holding");
      }, 350);
    } else if (phase === "holding") {
      timer = window.setTimeout(() => setPhase("ununderlining"), HOLD_MS);
    } else if (phase === "ununderlining") {
      setUnderlineState("shrinking");
      timer = window.setTimeout(() => {
        setUnderlineState("hidden");
        setPhase("deleting");
      }, UN_UNDERLINE_MS);
    } else if (phase === "deleting") {
      if (accentText.length > 0) {
        timer = window.setTimeout(() => {
          setAccentText(accent.slice(0, accentText.length - 1));
        }, ACCENT_DELETE_MS);
      } else {
        firstTypePass.current = false;
        timer = window.setTimeout(() => setPhase("typingAccent"), POST_DELETE_MS);
      }
    }

    return () => window.clearTimeout(timer);
  }, [phase, accentText, accent, loaded, reduced]);

  if (!loaded || reduced) {
    // SSR + reduced-motion: render static with underline visible.
    return (
      <h1 ref={rootRef} className={`${styles.headline} ${styles.static}`}>
        <span className={styles.srOnly}>{prefix} {accent}</span>
        <span aria-hidden="true" className={styles.prefix}>{prefix}</span>{" "}
        <span aria-hidden="true" className={`${styles.accent} ${styles.underlineFull}`}>{accent}</span>
      </h1>
    );
  }

  const prefixWords = prefix.split(/(\s+)/);
  let wordIdx = -1;

  const cursorClass = phase === "typingAccent" || phase === "deleting" || phase === "holding" || phase === "underlining" || phase === "ununderlining"
    ? styles.cursorOnAccent
    : "";

  const underlineClass =
    underlineState === "growing"
      ? styles.underlineGrowing
      : underlineState === "full"
      ? styles.underlineFull
      : underlineState === "shrinking"
      ? styles.underlineShrinking
      : "";

  return (
    <h1 ref={rootRef} className={`${styles.headline} ${cursorClass}`}>
      <span className={styles.srOnly}>{prefix} {accent}</span>
      <span aria-hidden="true" className={styles.prefix}>
        {prefixWords.map((segment, i) => {
          if (/^\s+$/.test(segment)) return <span key={i}>{segment}</span>;
          wordIdx++;
          return (
            <span
              key={i}
              className={styles.prefixWord}
              style={{
                animationDelay: `${startDelayMs + wordIdx * 120}ms`,
              }}
            >
              {segment}
            </span>
          );
        })}
      </span>
      <span aria-hidden="true" className={`${styles.accent} ${underlineClass}`}>
        {accentText}
      </span>
    </h1>
  );
}
