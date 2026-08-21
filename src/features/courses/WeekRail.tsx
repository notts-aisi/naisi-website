"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { WeekPlanEntry } from "@/lib/courses/weekPlan";
import styles from "./WeekRail.module.css";

/**
 * WeekRail — the signature element of the learning space.
 *
 * The navigation spine of `/learn/[runId]`: every taught week is a linked
 * node on one drawn track, breaks are dashed gaps, and the cohort's position
 * is a dropped-in "Now" marker. On a fresh session the rail draws itself in
 * over ~900ms — the orchestrated sequence specced in the design plan under
 * "The signature moment: the WeekRail draw" (inside-of-naisi-website
 * shiny-puffin plan); the draw IS the page answering "where am I" before a
 * single word is read.
 *
 * Measurement-free geometry: the track lives in a fixed 1000-unit viewBox
 * stretched with `preserveAspectRatio="none"`, node positions are pure
 * arithmetic over the plan's slot weights, and the draw's dash maths are
 * pinned by `pathLength` — no getTotalLength, no measurement, no resize
 * observer, ever. Node rings hard-code circumference 81.68 (r=13 in a
 * 32-unit box), the family constant shared with `ui/ProgressRing` so rail
 * and ring read as one system.
 *
 * `animate` is caller-owned: the run-home page keeps the once-per-session
 * flag (`sessionStorage "naisi:rail-drawn:<runId>"`) and passes the verdict
 * down. With `animate={false}` the final state renders immediately — the
 * from-state classes are never applied, so no transition can even start.
 *
 * Break labels are authored text and render strictly as text nodes.
 */

type Props = {
  plan: WeekPlanEntry[];
  /** Last taught week that has started (0 = none). Anchors the Now marker during breaks. */
  anchorWeekNumber: number;
  phase: "before" | "running" | "after";
  /** The cohort's current taught week, or null during a break / outside the run. */
  currentWeekNumber: number | null;
  completedWeekNumbers: number[];
  hrefForWeek: (weekNumber: number) => string;
  /** `full` = run home (labels, Now pill); `strip` = compact (smaller nodes, no labels). */
  variant?: "full" | "strip";
  /** Play the draw sequence this mount. Caller owns the session flag. */
  animate?: boolean;
};

/** Long axis of both track viewBoxes ("0 0 1000 12" horizontal, "0 0 12 1000" vertical). */
const VIEWBOX_LONG = 1000;

/**
 * A break occupies half a week slot — "a short dashed gap", not a full stop.
 * WeekRail.module.css encodes the same 1 : 0.5 ratio in its flex grow
 * factors, the `.many` fixed bases, and the vertical slot heights (via
 * `calc(… * 0.5)`); the SVG maths here and the DOM layout there must agree
 * for track and nodes to align. Change one, change all.
 */
const BREAK_WEIGHT = 0.5;

/** Past this many plan slots the horizontal rail becomes a scroll-snap container. */
const SCROLL_AT = 12;

/**
 * When the `.drawing` class is dropped. The headline draw is --dur-draw
 * (900ms); the halo afterglow runs to ~1500ms and the node pops of a very
 * long rail trail to ~1400ms. 1800ms clears `will-change` without racing
 * either, and because every keyframe's end state equals the base styles the
 * drop is visually a no-op (or an interrupt-safe snap to final state).
 */
const DRAW_DONE_MS = 1800;

type Span = readonly [number, number];

type RailGeometry = {
  /** Slot centres along the 0–1000 axis, indexed like `plan`. */
  centers: number[];
  first: number;
  last: number;
  /** Solid base-track segments (the rail minus break intervals). */
  solid: Span[];
  /** Break intervals, rendered as the dashed overlay. */
  dashed: Span[];
};

function railGeometry(plan: WeekPlanEntry[]): RailGeometry {
  const weights = plan.map((e) => (e.kind === "week" ? 1 : BREAK_WEIGHT));
  const total = weights.reduce((a, b) => a + b, 0);
  const centers: number[] = [];
  const breakSpans: Span[] = [];
  let cum = 0;
  plan.forEach((entry, i) => {
    const w = weights[i];
    centers.push(((cum + w / 2) / total) * VIEWBOX_LONG);
    if (entry.kind === "break") {
      breakSpans.push([
        (cum / total) * VIEWBOX_LONG,
        ((cum + w) / total) * VIEWBOX_LONG,
      ]);
    }
    cum += w;
  });

  const first = centers[0];
  const last = centers[centers.length - 1];
  // The track runs node-centre to node-centre; clamp break intervals into
  // that span so a plan that (pathologically) starts or ends on a break
  // still yields well-formed segments.
  const clamp = (v: number) => Math.min(Math.max(v, first), last);
  const dashed = breakSpans
    .map(([a, b]) => [clamp(a), clamp(b)] as const)
    .filter(([a, b]) => b - a > 0.5);

  const solid: Span[] = [];
  let pos = first;
  for (const [a, b] of dashed) {
    if (a - pos > 0.5) solid.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (last - pos > 0.5) solid.push([pos, last]);

  return { centers, first, last, solid, dashed };
}

function trackPath(spans: readonly Span[], vertical: boolean): string {
  return spans
    .map(([a, b]) =>
      vertical
        ? `M 6 ${a.toFixed(2)} V ${b.toFixed(2)}`
        : `M ${a.toFixed(2)} 6 H ${b.toFixed(2)}`,
    )
    .join(" ");
}

type TrackProps = {
  vertical: boolean;
  solid: readonly Span[];
  dashed: readonly Span[];
  progress: Span | null;
};

/**
 * One track SVG. Both orientations render (decorative, aria-hidden); CSS
 * shows exactly one per the 48rem breakpoint. The vertical variant is a
 * genuine viewBox swap — never a CSS rotation, which would break the stroke
 * maths under `non-scaling-stroke` (host-space dashes don't rotate with the
 * geometry).
 *
 * `vector-effect="non-scaling-stroke"` keeps every stroke crisp despite the
 * non-uniform `preserveAspectRatio="none"` stretch — and, as a bonus, gives
 * the break overlay constant screen-px dashes at any rail width. It also
 * moves dash arithmetic into host (screen) space, which is why the progress
 * path carries `pathLength={100}`: that renormalises its dash space to a
 * compile-time constant 100 whatever the rendered box measures, keeping the
 * draw measurement-free.
 *
 * Paint order is deliberate: base, then progress, then the dashed break
 * overlay last, so a drawn line crossing a break never repaints it solid.
 */
function Track({ vertical, solid, dashed, progress }: TrackProps) {
  const base = trackPath(solid, vertical);
  const breaks = trackPath(dashed, vertical);
  return (
    <svg
      className={vertical ? styles.trackV : styles.trackH}
      viewBox={vertical ? "0 0 12 1000" : "0 0 1000 12"}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {base && (
        <path
          className={styles.trackBase}
          d={base}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {progress && (
        <path
          className={styles.trackProgress}
          d={trackPath([progress], vertical)}
          vectorEffect="non-scaling-stroke"
          pathLength={100}
        />
      )}
      {breaks && (
        <path
          className={styles.trackBreaks}
          d={breaks}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export default function WeekRail({
  plan,
  anchorWeekNumber,
  phase,
  currentWeekNumber,
  completedWeekNumbers,
  hrefForWeek,
  variant = "full",
  animate = false,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const nowSlotRef = useRef<HTMLLIElement | null>(null);

  // `animate` is a mount-time verdict from the caller (it owns the
  // sessionStorage played-already flag), so seeding state from the prop is
  // deliberate, not a missed sync.
  const [drawing, setDrawing] = useState(animate);

  useEffect(() => {
    if (!drawing) return;
    // Timed class drop rather than animationend: the last animation to
    // finish varies (the halo needs a current node; a long rail's node pops
    // trail past the marker), and CSS-module keyframe names are hashed so
    // matching event.animationName is brittle.
    const t = window.setTimeout(() => setDrawing(false), DRAW_DONE_MS);
    return () => window.clearTimeout(t);
  }, [drawing]);

  useEffect(() => {
    // Mount-time centre-on-current for >12-slot rails: scrollLeft maths on
    // the rail's OWN scroll container — deliberately not scrollIntoView,
    // which also scrolls ancestors and would yank the page to the rail on
    // load. No-op whenever nothing overflows (short plans, or the vertical
    // layout below 48rem where the container never scrolls).
    const scroller = scrollerRef.current;
    const slot = nowSlotRef.current;
    if (!scroller || !slot) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollLeft =
      slot.offsetLeft + slot.offsetWidth / 2 - scroller.clientWidth / 2;
  }, []);

  if (plan.length === 0) return null;

  // The slot carrying the Now marker. During a break `currentWeekNumber` is
  // null, so fall back to `anchorWeekNumber` — the last taught week that has
  // started, the same anchor every "you should be up to here" surface uses —
  // so a cohort on reading week reads as "still at week 4", not unplaced.
  let nowIdx: number | null = null;
  if (phase === "running") {
    const target =
      currentWeekNumber ?? (anchorWeekNumber > 0 ? anchorWeekNumber : null);
    if (target !== null) {
      const found = plan.findIndex(
        (e) => e.kind === "week" && e.weekNumber === target,
      );
      nowIdx = found === -1 ? null : found;
    }
  }

  const { centers, first, last, solid, dashed } = railGeometry(plan);

  // Where the accent line stops: the current week while running, the whole
  // rail once the run is over, nowhere before it starts.
  const progressEnd =
    phase === "after"
      ? last
      : phase === "running" && nowIdx !== null
        ? centers[nowIdx]
        : null;
  const progress: Span | null =
    progressEnd !== null && progressEnd - first > 0.5
      ? [first, progressEnd]
      : null;

  const completed = new Set(completedWeekNumbers);

  const railClass = [
    styles.rail,
    variant === "strip" ? styles.strip : styles.full,
    drawing ? styles.drawing : "",
    plan.length > SCROLL_AT ? styles.many : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <nav className={railClass} aria-label="Course weeks">
      <div ref={scrollerRef} className={styles.scroller}>
        <div className={styles.canvas}>
          <div className={styles.listWrap}>
            <Track
              vertical={false}
              solid={solid}
              dashed={dashed}
              progress={progress}
            />
            <Track
              vertical={true}
              solid={solid}
              dashed={dashed}
              progress={progress}
            />
            <ol className={styles.list}>
              {plan.map((entry, i) => {
                // --i staggers the pop-in left to right; breaks consume a
                // beat too so the wave stays physically continuous.
                const slotStyle = { "--i": i } as CSSProperties;

                if (entry.kind === "break") {
                  return (
                    <li
                      key={`break-${i}`}
                      className={`${styles.slot} ${styles.breakSlot}`}
                      style={slotStyle}
                    >
                      {/* A break is calendar padding on the track, not a
                          destination: an aria-disabled span, never a link.
                          The label always renders for AT; the strip variant
                          hides it visually (no labels there). */}
                      <span className={styles.breakLabel} aria-disabled="true">
                        {entry.label}
                      </span>
                    </li>
                  );
                }

                const isCurrent =
                  phase === "running" &&
                  currentWeekNumber !== null &&
                  entry.weekNumber === currentWeekNumber;
                const isNow = nowIdx === i;
                const isDone = completed.has(entry.weekNumber);
                const nodeClass = [
                  styles.node,
                  isDone ? styles.done : "",
                  isNow ? styles.now : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <li
                    key={entry.weekId}
                    ref={isNow ? nowSlotRef : undefined}
                    className={`${styles.slot} ${styles.weekSlot}`}
                    style={slotStyle}
                  >
                    <Link
                      href={hrefForWeek(entry.weekNumber)}
                      className={nodeClass}
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      <span className={styles.srOnly}>
                        {`Week ${entry.weekNumber}` +
                          (isDone ? ", completed" : "") +
                          (isCurrent ? ", current week" : "")}
                      </span>
                      <span className={styles.ringBox} aria-hidden="true">
                        <svg
                          className={styles.ring}
                          viewBox="0 0 32 32"
                          focusable="false"
                        >
                          <circle
                            className={styles.ringOutline}
                            cx="16"
                            cy="16"
                            r="13"
                          />
                          {isDone && (
                            /* rotate(-90) starts the completion sweep at 12
                               o'clock, same as ProgressRing's fill arc. */
                            <circle
                              className={styles.ringSweep}
                              cx="16"
                              cy="16"
                              r="13"
                              transform="rotate(-90 16 16)"
                            />
                          )}
                          {isDone && (
                            <path
                              className={styles.check}
                              d="M10.8 16.8 L14.4 20.2 L21.4 12.6"
                            />
                          )}
                        </svg>
                        {/* Completed nodes trade the number for the check
                            (the stepper convention); strip hides numbers
                            entirely via CSS. */}
                        {!isDone && (
                          <span className={styles.num}>{entry.weekNumber}</span>
                        )}
                      </span>
                    </Link>
                    {isNow && (
                      /* Positional cue only — aria-current="step" already
                         carries the semantics, so the marker is hidden from
                         AT (and would otherwise pollute the link name). */
                      <span className={styles.nowMarker} aria-hidden="true">
                        Now
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </nav>
  );
}
