"use client";

/**
 * Two responsibilities, deliberately split:
 *
 *  • `<PublicTransitionProvider>` is the context owner. It wraps the
 *    ENTIRE public layout (header + main + footer) so any descendant —
 *    including PublicHeader, which is a sibling of PublicMain — can
 *    consume `usePublicTransition()` to participate in the exit
 *    choreography (header-lift before body-fade before nav).
 *
 *  • `<PublicMain>` is the `<main>` element. It consumes the context
 *    to know when to play its body fade-out, and owns its own first-
 *    paint FOUC mask via inline opacity + class-swap on next rAF.
 *
 * They USED to be one component, with the Provider scoped inside
 * `<main>` — that made the header invisible to the context (siblings
 * don't see it), so header lift never fired. Don't recombine.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import styles from "./PublicMain.module.css";

type PublicTransitionContext = {
  /** Fade the public page out then navigate. Used by header sign-in
   *  links so /login's swipe-in is preceded by a graceful exit instead
   *  of a hard cut. Calls are idempotent once an exit is in flight. */
  startExitTo: (url: string) => void;
  /** True once the page-body fade-out is in progress. */
  exiting: boolean;
  /** True once the header has started lifting upward (fires BEFORE
   *  `exiting` so the banner clears the viewport before the page
   *  fades out + the auth route takes over). */
  headerLifting: boolean;
};

const Ctx = createContext<PublicTransitionContext | null>(null);

export function usePublicTransition() {
  return useContext(Ctx);
}

/** Page-body fade-out duration. Keep in sync with .exiting keyframes
 *  in PublicMain.module.css. */
export const PUBLIC_EXIT_MS = 540;
/** Head start the banner gets to lift off-screen BEFORE the body
 *  starts fading. Has to be long enough for the user to register the
 *  banner leaving as a discrete moment before the page transition. */
export const HEADER_LIFT_HEAD_START_MS = 420;

export function PublicTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [exiting, setExiting] = useState(false);
  const [headerLifting, setHeaderLifting] = useState(false);
  const exitingRef = useRef(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("naisi:from-signout") === "1") {
        sessionStorage.removeItem("naisi:from-signout");
      }
    } catch {
      // sessionStorage unavailable — nothing to clean up
    }
  }, []);

  const startExitTo = useCallback(
    (url: string) => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      // 1) Lift the banner immediately. PublicHeader subscribes to
      //    `headerLifting` and animates upward over 540ms.
      setHeaderLifting(true);
      // 2) After the banner has had a head-start (420ms — ~78% lifted on
      //    the smooth curve), start the body fade-out.
      setTimeout(() => setExiting(true), HEADER_LIFT_HEAD_START_MS);
      // 3) Once both motions are done, navigate. Total wait ≈ 960ms.
      setTimeout(
        () => router.push(url),
        HEADER_LIFT_HEAD_START_MS + PUBLIC_EXIT_MS,
      );
    },
    [router],
  );

  return (
    <Ctx.Provider value={{ startExitTo, exiting, headerLifting }}>
      {children}
    </Ctx.Provider>
  );
}

export default function PublicMain({ children }: { children: ReactNode }) {
  const ctx = useContext(Ctx);
  const exiting = ctx?.exiting ?? false;
  // The CRUX of the FOUC fix. We render the main element with an inline
  // opacity:0 + translateY(4px) so the FIRST paint (whether from SSR
  // hydration or a fresh client render) is guaranteed invisible. Then
  // on the next animation frame we flip `animate` true, which swaps in
  // the .mainAnim class. The CSS animation's from-state matches the
  // inline style exactly, so the handoff is seamless — no flash where
  // content was briefly visible before the animation took hold.
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    // One rAF to ensure the initial inline-style paint commits before
    // React's re-render swaps to the animated class. Without this the
    // two paints can collapse into one, defeating the mask.
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const className = [
    styles.main,
    animate ? styles.mainAnim : "",
    exiting ? styles.exiting : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Inline style is only applied for the pre-animation frame. Once the
  // .mainAnim class lands, the animation's from-state takes over.
  const initialStyle = !animate && !exiting
    ? ({ opacity: 0, transform: "translateY(4px)" } as const)
    : undefined;

  return (
    <main className={className} style={initialStyle}>
      {children}
    </main>
  );
}
