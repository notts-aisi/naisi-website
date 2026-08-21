"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./TypewriterText.module.css";

export type EllipsisStyle = "wave" | "spinner" | "pulse" | "typing" | "blink";

type Props = {
  /** Current target text. When this changes, the typewriter smoothly
   *  erases to the longest common prefix with the previous text, then
   *  types the new target. */
  text: string;
  ellipsisStyle?: EllipsisStyle;
  typingSpeedMs?: number;
  eraseSpeedMs?: number;
  /** Ms to dwell with ellipsis showing once the target is fully typed
   *  before calling `onSettled`. */
  holdMs?: number;
  /** Fires the instant typing completes (before `holdMs` elapses). Use
   *  for things like revealing a success tick the moment the word lands. */
  onTypingComplete?: () => void;
  /** Fires `holdMs` after the target finishes typing. Use this in the
   *  parent to advance a cycle (parent updates `text` prop to the next
   *  phrase, which triggers the next smooth transition). */
  onSettled?: () => void;
  /** Visual tone — "success" renders the text in electric green with a
   *  soft glow, intended for the post-sign-in "Model aligned" moment. */
  tone?: "default" | "success";
};

export default function TypewriterText({
  text,
  ellipsisStyle = "wave",
  typingSpeedMs = 95,
  eraseSpeedMs = 60,
  holdMs = 1800,
  onTypingComplete,
  onSettled,
  tone = "default",
}: Props) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  // True while we're typing the CURRENT target (post-erase). The tone
  // (e.g. success green) is only applied during this window — never
  // during the erase of the previous text, which would otherwise paint
  // the outgoing word green pre-emptively.
  const [isTypingNew, setIsTypingNew] = useState(false);
  const displayedRef = useRef("");
  const onSettledRef = useRef(onSettled);
  const onTypingCompleteRef = useRef(onTypingComplete);
  useEffect(() => {
    onSettledRef.current = onSettled;
    onTypingCompleteRef.current = onTypingComplete;
  });

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

    const setDisplay = (s: string) => {
      displayedRef.current = s;
      setDisplayed(s);
    };

    async function run() {
      const startFrom = displayedRef.current;
      const target = text;

      let common = 0;
      while (
        common < startFrom.length &&
        common < target.length &&
        startFrom[common] === target[common]
      ) {
        common++;
      }

      setDone(false);
      // If there's anything to erase from the previous text, we're not
      // yet typing the new target. Suppress the success tone during this
      // window so the outgoing phrase doesn't pick up the green colour.
      if (startFrom.length > common) {
        setIsTypingNew(false);
      }
      // Erase down to common prefix
      for (let j = startFrom.length - 1; j >= common; j--) {
        if (cancelled) return;
        setDisplay(startFrom.slice(0, j));
        await sleep(eraseSpeedMs);
      }

      // Switch into "typing the new target" once erase is done. The tone
      // (e.g. success green) takes effect from this point.
      if (cancelled) return;
      setIsTypingNew(true);

      // Type up to target
      for (let j = common + 1; j <= target.length; j++) {
        if (cancelled) return;
        setDisplay(target.slice(0, j));
        await sleep(typingSpeedMs);
      }
      if (cancelled) return;

      // Settle on full text + ellipsis
      setDone(true);
      onTypingCompleteRef.current?.();
      if (holdMs > 0) {
        await sleep(holdMs);
        if (cancelled) return;
        onSettledRef.current?.();
      } else {
        onSettledRef.current?.();
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [text, typingSpeedMs, eraseSpeedMs, holdMs]);

  return (
    <div className={`${styles.wrap} ${tone === "success" && isTypingNew ? styles.toneSuccess : ""}`} aria-live="polite">
      <span className={styles.text}>{displayed}</span>
      {!done ? (
        <span className={styles.caretBlink} aria-hidden="true">▍</span>
      ) : (
        <Ellipsis style={ellipsisStyle} />
      )}
    </div>
  );
}

function Ellipsis({ style }: { style: EllipsisStyle }) {
  if (style === "wave") {
    return (
      <span className={styles.ellipsisWrap} aria-hidden="true">
        <span className={`${styles.dot} ${styles.dotWave1}`}>.</span>
        <span className={`${styles.dot} ${styles.dotWave2}`}>.</span>
        <span className={`${styles.dot} ${styles.dotWave3}`}>.</span>
      </span>
    );
  }
  if (style === "spinner") {
    return <span className={styles.spinner} aria-hidden="true" />;
  }
  if (style === "pulse") {
    return (
      <span className={styles.ellipsisWrap} aria-hidden="true">
        <span className={`${styles.dot} ${styles.dotPulse1}`}>.</span>
        <span className={`${styles.dot} ${styles.dotPulse2}`}>.</span>
        <span className={`${styles.dot} ${styles.dotPulse3}`}>.</span>
      </span>
    );
  }
  if (style === "typing") {
    return (
      <span className={styles.ellipsisWrap} aria-hidden="true">
        <span className={`${styles.dot} ${styles.dotTyping1}`}>.</span>
        <span className={`${styles.dot} ${styles.dotTyping2}`}>.</span>
        <span className={`${styles.dot} ${styles.dotTyping3}`}>.</span>
      </span>
    );
  }
  return <span className={styles.caretBlink} aria-hidden="true">▍</span>;
}
