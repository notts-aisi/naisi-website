"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import styles from "./TypedHeadline.module.css";

type Props = {
  /** Word-by-word blur-to-focus reveal on load. Stays static after. */
  prefix?: string;
  /** Typed char-by-char, underlined, deleted, looped forever. */
  accent?: string;
  /** Delay (s) before the prefix's first word begins revealing. */
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

// Speeds tuned to feel like a deliberate typist, not a script.
const ACCENT_TYPE_FIRST_MS = 95;
const ACCENT_TYPE_LOOP_MS = 110;
const ACCENT_DELETE_MS = 55;
const HOLD_MS = 2800;
const PRE_UNDERLINE_MS = 350;
const UN_UNDERLINE_MS = 280;
const POST_DELETE_MS = 750;

/*
  Hero headline.

  Prefix words use motion.span — motion handles paint timing, Safari
  quirks, and reduced-motion automatically. Each word has its own
  staggered delay calculated from the word index.

  Accent text is JS-driven (typed char-by-char then looped). Caret is
  a JSX child at the trailing edge so it follows each character.
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
  const [mounted, setMounted] = useState(false);
  const [firstTypePass, setFirstTypePass] = useState(true);

  // Honor reduced motion and mark mounted so we can start the loop.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reducedMatch = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setReduced(reducedMatch);
    setMounted(true);
  }, []);

  // Kick the accent loop off after the prefix word-stagger lands.
  useEffect(() => {
    if (!mounted || reduced) return;
    const prefixWordCount = prefix.split(/\s+/).filter(Boolean).length;
    // Words start at startDelayMs and stagger 120ms apart; each
    // animation takes ~700ms. Add 200ms breath after the last lands.
    const prefixDoneAt = startDelayMs + 700 + (prefixWordCount - 1) * 120 + 200;
    const id = window.setTimeout(() => setPhase("typingAccent"), prefixDoneAt);
    return () => window.clearTimeout(id);
  }, [mounted, reduced, prefix, startDelayMs]);

  // Accent phase machine.
  useEffect(() => {
    if (!mounted || reduced) return;
    let timer = 0;

    if (phase === "typingAccent") {
      if (accentText.length < accent.length) {
        const interval = firstTypePass ? ACCENT_TYPE_FIRST_MS : ACCENT_TYPE_LOOP_MS;
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
        setFirstTypePass(false);
        timer = window.setTimeout(() => setPhase("typingAccent"), POST_DELETE_MS);
      }
    }

    return () => window.clearTimeout(timer);
  }, [phase, accentText, accent, mounted, reduced, firstTypePass]);

  // Static rendering for SSR + reduced motion. Same DOM shape as the
  // dynamic version so hydration matches cleanly.
  if (!mounted || reduced) {
    return (
      <h1 className={`${styles.headline} ${styles.static}`}>
        <span className={styles.srOnly}>{prefix} {accent}</span>
        <span aria-hidden="true" className={styles.prefix}>{prefix}</span>{" "}
        <span aria-hidden="true" className={`${styles.accent} ${styles.underlineFull}`}>
          <span className={styles.accentText}>{accent}</span>
        </span>
      </h1>
    );
  }

  const prefixWords = prefix.split(/(\s+)/);
  let wordIdx = -1;

  const showCaret =
    phase === "typingAccent" ||
    phase === "deleting" ||
    phase === "holding" ||
    phase === "underlining" ||
    phase === "ununderlining";

  const underlineClass =
    underlineState === "growing"
      ? styles.underlineGrowing
      : underlineState === "full"
      ? styles.underlineFull
      : underlineState === "shrinking"
      ? styles.underlineShrinking
      : "";

  return (
    <h1 className={styles.headline}>
      <span className={styles.srOnly}>{prefix} {accent}</span>
      <span aria-hidden="true" className={styles.prefix}>
        {prefixWords.map((segment, i) => {
          if (/^\s+$/.test(segment)) return <span key={i}>{segment}</span>;
          wordIdx++;
          const delaySec = (startDelayMs + wordIdx * 120) / 1000;
          return (
            <motion.span
              key={i}
              className={styles.prefixWord}
              initial={{ opacity: 0, y: 18, filter: "blur(14px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.7, delay: delaySec, ease: [0.22, 0.61, 0.36, 1] }}
            >
              {segment}
            </motion.span>
          );
        })}
      </span>{" "}
      <span aria-hidden="true" className={`${styles.accent} ${underlineClass}`}>
        <span className={styles.accentText}>{accentText}</span>
        {showCaret && <span className={styles.caret}>|</span>}
      </span>
    </h1>
  );
}
