"use client";

import { useCallback, useEffect, useState } from "react";
import LivingPlasma from "./loaders/LivingPlasma";
import TypewriterText from "./loaders/TypewriterText";
import styles from "./SigningIn.module.css";

/**
 * Sign-in ambient loader. Always rendered on the login surface — the
 * `active` prop controls whether the network is idling or surging.
 *
 * Idle: single slow wavefront, sparse pulses, "Waiting for user prompt" +
 *   pulse-fade dots — reads as a persistent ambient design element.
 *
 * Active: three iris rings fan out, six pulses per burst stream along
 *   curved bezier paths, typewriter cycles through 20 AI-inference
 *   phrases (random start, fixed order) with a spinner ellipsis.
 *
 * Magnetic mouse attractor in both states so the loader is also a fidget
 * toy. Honors `prefers-reduced-motion` via LivingPlasma's internal check.
 */

const ACTIVE_PHRASES = [
  "Running inference",
  "Capturing hidden activations",
  "Computing attention",
  "Sampling tokens",
  "Forward pass",
  "Aligning embeddings",
  "Softmaxing logits",
  "Decoding completion",
  "Layer normalisation",
  "Greedy decoding",
  "Beam searching",
  "Cross-attending",
  "Quantising weights",
  "Computing perplexity",
  "Hallucinating gently",
  "Speculating tokens",
  "Backpropagating regrets",
  "Annealing softly",
  "Distilling vibes",
  "Convolving thoughts",
] as const;

const IDLE_TEXT = "Waiting for user prompt";
const SUCCESS_TEXT = "Model aligned";

type Props = {
  active: boolean;
  /** Set to a `performance.now()` timestamp by the parent when the user
   *  has successfully signed in — triggers the green sweep that locks
   *  every node green before the card slides out. */
  successStartAt?: number | null;
};

export default function SigningIn({ active, successStartAt = null }: Props) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [tickVisible, setTickVisible] = useState(false);

  // Random starting phrase each time we enter active mode.
  useEffect(() => {
    if (active) {
      setPhraseIdx(Math.floor(Math.random() * ACTIVE_PHRASES.length));
    }
  }, [active]);

  const inSuccess = successStartAt != null;

  // Reset the tick whenever we leave success (e.g. cancellation).
  useEffect(() => {
    if (!inSuccess) setTickVisible(false);
  }, [inSuccess]);

  // Advance to the next phrase after typewriter settles (only while
  // active and not in success; idle and success both fire once after
  // their settled state and the callback is a no-op).
  const onSettled = useCallback(() => {
    if (active && !inSuccess) {
      setPhraseIdx((i) => (i + 1) % ACTIVE_PHRASES.length);
    }
  }, [active, inSuccess]);

  // Reveal the tick the instant the success word lands — not before.
  const onTypingComplete = useCallback(() => {
    if (inSuccess) setTickVisible(true);
  }, [inSuccess]);

  const text = inSuccess ? SUCCESS_TEXT : active ? ACTIVE_PHRASES[phraseIdx] : IDLE_TEXT;

  return (
    <div className={styles.container} role="status" aria-live="polite">
      <div className={styles.networkWrap}>
        <LivingPlasma
          active={active}
          attractor="magnetic"
          magneticPullRadius={105}
          magneticPullStrength={16}
          successStartAt={successStartAt}
        />
      </div>
      <div className={styles.textRow}>
        <TypewriterText
          text={text}
          ellipsisStyle={inSuccess ? "blink" : active ? "spinner" : "pulse"}
          tone={inSuccess ? "success" : "default"}
          typingSpeedMs={95}
          eraseSpeedMs={60}
          holdMs={1800}
          onTypingComplete={onTypingComplete}
          onSettled={onSettled}
        />
        {inSuccess && tickVisible && <SuccessTick />}
      </div>
    </div>
  );
}

function SuccessTick() {
  return (
    <svg
      className={styles.successTick}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10.5"
        fill="hsla(142, 70%, 50%, 0.18)"
        stroke="hsla(142, 80%, 62%, 0.9)"
        strokeWidth="1.4"
      />
      <path
        d="M7 12.5 L10.5 16 L17 9"
        stroke="hsla(142, 92%, 80%, 1)"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={styles.successTickPath}
      />
    </svg>
  );
}
