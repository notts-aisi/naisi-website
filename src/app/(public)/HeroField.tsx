"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";

/*
  HeroField — feed-forward neural network visualization.

  Nodes are arranged in 4 explicit layers (input → hidden → hidden →
  output), each a vertical column spaced across the hero. Edges connect
  adjacent layers only. Activations propagate left-to-right via pulses
  that travel along edges, like signal through a network.

  Perf:
    - No ctx.shadowBlur (the canvas killer). Glow via a 2nd low-opacity arc.
    - Pulses capped to 1 in-flight per edge.
    - Cascade depth capped at 2 with intensity floor 0.25 — chains die.
    - Cursor-nearest cached and only recomputed when cursor moves > 8px.
    - IntersectionObserver pauses the rAF when off-screen.
    - prefers-reduced-motion → single static frame, no rAF.
*/

type Pulse = { progress: number; intensity: number; depth: number };
type Edge = { from: number; to: number; pulse: Pulse | null };
type Node = {
  x: number; y: number;
  vx: number; vy: number;
  hx: number; hy: number;
  layer: number;
  outEdges: number[]; // indices into edges array
  activation: number;
};

const LAYER_COUNT = 4;
const PULSE_TRAVEL_MS = 700;
const SPONT_FIRE_MS = 1100;     // shorter gap — keep the field feeling alive
const CASCADE_INTENSITY_FLOOR = 0.22;
const CASCADE_DEPTH_MAX = 2;
const CASCADE_DECAY = 0.6;       // slightly less decay so cascades feel decisive
const CURSOR_RECOMPUTE_PX = 8;
const CURSOR_FIRE_COOLDOWN_MS = 500;
const CURSOR_FIRE_DIST = 70;

export default function HeroField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0;
    let height = 0;
    let nodes: Node[] = [];
    let edges: Edge[] = [];
    let scrollY = 0;
    // Node/edge/pulse colours now come from the heatmap based on
    // activation; the accent token isn't needed at render time.

    /**
     * Build a feed-forward layout: 4 layers with N nodes each, edges
     * between adjacent layers only.
     *
     * Orientation auto-picks based on the aspect ratio:
     *   - landscape / desktop (wider than tall): layers run LEFT → RIGHT,
     *     nodes within a layer spread vertically. Signal flows rightward.
     *   - portrait / mobile (taller than wide, or width < 600): layers
     *     run TOP → BOTTOM, nodes within a layer spread horizontally.
     *     Signal flows downward, matching the natural portrait reading.
     */
    const init = () => {
      nodes = [];
      edges = [];

      const vertical = width < height || width < 600;
      // Spread axis is where nodes within a layer fan out:
      //   horizontal layout → spread along Y (use height as budget)
      //   vertical layout   → spread along X (use width as budget)
      const layerCounts = pickLayerCounts(vertical ? width : height);
      const layerFractions = [0.10, 0.36, 0.64, 0.90];

      for (let l = 0; l < LAYER_COUNT; l++) {
        const count = layerCounts[l];
        if (vertical) {
          // Layer is a horizontal row at a specific Y. Nodes spread along X.
          const padding = width * 0.10;
          const usable = width - padding * 2;
          const step = count > 1 ? usable / (count - 1) : 0;
          const yPos = layerFractions[l] * height;
          for (let i = 0; i < count; i++) {
            const baseX = padding + (count > 1 ? step * i : usable / 2);
            const jitterY = (Math.random() - 0.5) * (height / 60);
            const jitterX = (Math.random() - 0.5) * (step * 0.18);
            const x = baseX + jitterX;
            const y = yPos + jitterY;
            nodes.push({
              x, y, vx: 0, vy: 0,
              hx: x, hy: y,
              layer: l,
              outEdges: [],
              activation: 0,
            });
          }
        } else {
          // Layer is a vertical column at a specific X. Nodes spread along Y.
          const padding = height * 0.12;
          const usable = height - padding * 2;
          const step = count > 1 ? usable / (count - 1) : 0;
          const xPos = layerFractions[l] * width;
          for (let i = 0; i < count; i++) {
            const baseY = padding + (count > 1 ? step * i : usable / 2);
            const jitterX = (Math.random() - 0.5) * (width / 60);
            const jitterY = (Math.random() - 0.5) * (step * 0.18);
            const x = xPos + jitterX;
            const y = baseY + jitterY;
            nodes.push({
              x, y, vx: 0, vy: 0,
              hx: x, hy: y,
              layer: l,
              outEdges: [],
              activation: 0,
            });
          }
        }
      }

      // Edges — each node connects to ~3 of the next layer's nodes.
      // Picks the 3 nearest along the spread axis for a less-tangled look.
      // (In horizontal layout that's Y distance; in vertical it's X.)
      const vertical2 = width < height || width < 600;
      for (let l = 0; l < LAYER_COUNT - 1; l++) {
        const src = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l);
        const dst = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l + 1);
        for (const s of src) {
          const sorted = dst
            .map((d) => ({
              idx: d.i,
              d: vertical2
                ? Math.abs(d.n.hx - s.n.hx)
                : Math.abs(d.n.hy - s.n.hy),
            }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 3);
          for (const d of sorted) {
            const edgeIdx = edges.length;
            edges.push({ from: s.i, to: d.idx, pulse: null });
            s.n.outEdges.push(edgeIdx);
          }
        }
      }
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      init();
    };

    resize();

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    // Cursor — cached neighbours, recomputed only on meaningful move.
    let cursorX = -1000;
    let cursorY = -1000;
    let lastCursorComputeX = -1000;
    let lastCursorComputeY = -1000;
    let cachedCursorNeighbours: number[] = [];
    let lastCursorFireAt = -Infinity;

    const recomputeCursorNeighbours = () => {
      let best0 = -1, d0 = Infinity;
      let best1 = -1, d1 = Infinity;
      let best2 = -1, d2 = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const dx = nodes[i].x - cursorX;
        const dy = nodes[i].y - cursorY;
        const d = dx * dx + dy * dy;
        if (d < d0) { d2 = d1; best2 = best1; d1 = d0; best1 = best0; d0 = d; best0 = i; }
        else if (d < d1) { d2 = d1; best2 = best1; d1 = d; best1 = i; }
        else if (d < d2) { d2 = d; best2 = i; }
      }
      cachedCursorNeighbours = [best0, best1, best2].filter((x) => x >= 0);
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursorX = e.clientX - rect.left;
      cursorY = e.clientY - rect.top;
    };
    const onLeave = () => {
      cursorX = -1000;
      cursorY = -1000;
      cachedCursorNeighbours = [];
    };
    if (!coarse) {
      canvas.parentElement?.addEventListener("mousemove", onMove);
      canvas.parentElement?.addEventListener("mouseleave", onLeave);
    }

    const onScroll = () => { scrollY = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });

    const ATMOSPHERE_GATE_MS = 3000;
    const startMs = performance.now();

    let lastT = performance.now();
    let lastSpontFireAt = startMs;
    let frame = 0;
    let visible = true;

    /**
     * Fire a node — bump its activation and spawn pulses along all
     * outgoing edges. Cascade dies on depth or intensity floor.
     */
    const fireNode = (idx: number, intensity = 1, depth = 0) => {
      if (intensity < CASCADE_INTENSITY_FLOOR) return;
      if (depth > CASCADE_DEPTH_MAX) {
        // Last hop — bump activation, don't propagate further.
        const n = nodes[idx];
        if (n) n.activation = Math.max(n.activation, intensity);
        return;
      }
      const n = nodes[idx];
      if (!n) return;
      n.activation = Math.max(n.activation, intensity);
      for (const eIdx of n.outEdges) {
        const e = edges[eIdx];
        if (!e || e.pulse) continue; // skip if a pulse is already in flight
        e.pulse = { progress: 0, intensity, depth };
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(33, now - lastT);
      lastT = now;
      const atmosphereOn = now - startMs > ATMOSPHERE_GATE_MS;
      const parallax = scrollY * 0.12;

      ctx.clearRect(0, 0, width, height);

      // Drift nodes
      if (!reduced) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          n.vx += (Math.random() - 0.5) * 0.015;
          n.vy += (Math.random() - 0.5) * 0.015;
          n.vx *= 0.94;
          n.vy *= 0.94;
          n.vx += (n.hx - n.x) * 0.0015;
          n.vy += (n.hy - n.y) * 0.0015;
          n.x += n.vx;
          n.y += n.vy;
          n.activation *= 0.94;
        }
      }

      // Cursor recompute (only on meaningful move)
      if (!coarse && cursorX > -100) {
        const dx = cursorX - lastCursorComputeX;
        const dy = cursorY - lastCursorComputeY;
        if (dx * dx + dy * dy > CURSOR_RECOMPUTE_PX * CURSOR_RECOMPUTE_PX) {
          recomputeCursorNeighbours();
          lastCursorComputeX = cursorX;
          lastCursorComputeY = cursorY;

          // Trigger an activation if cursor is right on a node
          if (atmosphereOn && cachedCursorNeighbours.length) {
            const n = nodes[cachedCursorNeighbours[0]];
            const distSq = (n.x - cursorX) ** 2 + (n.y - cursorY) ** 2;
            if (
              distSq < CURSOR_FIRE_DIST * CURSOR_FIRE_DIST &&
              now - lastCursorFireAt > CURSOR_FIRE_COOLDOWN_MS
            ) {
              fireNode(cachedCursorNeighbours[0], 0.8);
              lastCursorFireAt = now;
            }
          }
        }
      }

      // Spontaneous input-layer fires (every SPONT_FIRE_MS ms on average)
      if (atmosphereOn && !reduced && now - lastSpontFireAt > SPONT_FIRE_MS * (0.7 + Math.random() * 0.6)) {
        // Pick a random node in the INPUT layer (layer 0) — forward flow
        const inputNodes = [];
        for (let i = 0; i < nodes.length; i++) if (nodes[i].layer === 0) inputNodes.push(i);
        const target = inputNodes[Math.floor(Math.random() * inputNodes.length)];
        fireNode(target, 0.95);
        lastSpontFireAt = now;
      }

      // Draw edges + advance pulses
      ctx.lineCap = "round";
      ctx.lineWidth = 1.2;

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const a = nodes[e.from];
        const b = nodes[e.to];
        const x1 = a.x;
        const y1 = a.y - parallax;
        const x2 = b.x;
        const y2 = b.y - parallax;

        // Edge colour = heatmap of the brighter endpoint. At rest both
        // are 0, so edges read as cool NAISI blue. When a node fires,
        // its outgoing edges warm up too — telling the signal story.
        const endpointMax = Math.max(a.activation, b.activation);
        const edgeAlpha = 0.14 + endpointMax * 0.55;
        ctx.strokeStyle = heat(endpointMax, edgeAlpha);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Pulse on this edge
        if (e.pulse && !reduced) {
          e.pulse.progress += dt / PULSE_TRAVEL_MS;
          if (e.pulse.progress >= 1) {
            const arrivingIntensity = e.pulse.intensity * CASCADE_DECAY;
            const arrivingDepth = e.pulse.depth + 1;
            const targetIdx = e.to;
            e.pulse = null;
            fireNode(targetIdx, arrivingIntensity, arrivingDepth);
          } else {
            const px = x1 + (x2 - x1) * e.pulse.progress;
            const py = y1 + (y2 - y1) * e.pulse.progress;
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const half = 12;
            // Pulse colour reflects how hot the activation it carries is.
            ctx.strokeStyle = heat(e.pulse.intensity, 1.0);
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(px - ux * half, py - uy * half);
            ctx.lineTo(px + ux * half, py + uy * half);
            ctx.stroke();
            ctx.lineWidth = 1.2;
          }
        }
      }

      // Cursor virtual edges (only on hover, only to 3 nearest).
      // Coloured by the nearest node's activation so the cursor's
      // virtual links also follow the heatmap.
      if (!coarse && cachedCursorNeighbours.length && cursorX > -100) {
        for (let i = 0; i < cachedCursorNeighbours.length; i++) {
          const n = nodes[cachedCursorNeighbours[i]];
          const dx = n.x - cursorX;
          const dy = (n.y - parallax) - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const a = Math.max(0, 0.22 * (1 - dist / 200));
          if (a > 0.01) {
            ctx.strokeStyle = heat(n.activation, a);
            ctx.beginPath();
            ctx.moveTo(cursorX, cursorY);
            ctx.lineTo(n.x, n.y - parallax);
            ctx.stroke();
          }
        }
      }

      // Nodes — base dot + halo if active. Colour by activation via the
      // heatmap so a firing node visibly heats up from blue → red.
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const renderY = n.y - parallax;

        // Halo for activated nodes — outer soft glow + inner ring at
        // the node's current heatmap colour.
        if (n.activation > 0.06) {
          const haloAlpha = n.activation * 0.55;
          ctx.fillStyle = heat(n.activation, haloAlpha * 0.4);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 7 + n.activation * 10, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = heat(n.activation, haloAlpha);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 3 + n.activation * 5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core dot — heatmap colour matches activation. Resting nodes
        // stay NAISI blue; firing ones warm through cyan / green /
        // yellow / orange / red as they propagate.
        const radius = 2 + n.activation * 1.8;
        const alpha = 0.7 + n.activation * 0.3;
        ctx.fillStyle = heat(n.activation, alpha);
        ctx.beginPath();
        ctx.arc(n.x, renderY, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      // Static frame: every input-layer node at mid activation
      for (const n of nodes) if (n.layer === 0) n.activation = 0.5;
      draw(performance.now());
    } else {
      frame = requestAnimationFrame(draw);
    }

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        visible = entry.isIntersecting;
        if (visible && !frame && !reduced) {
          lastT = performance.now();
          frame = requestAnimationFrame(draw);
        } else if (!visible && frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      }
    }, { threshold: 0 });
    io.observe(canvas);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      canvas.parentElement?.removeEventListener("mousemove", onMove);
      canvas.parentElement?.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}

/**
 * Pick layer node counts based on viewport. Slimmer on mobile.
 * Returns 4 numbers for [input, hidden1, hidden2, output].
 */
/**
 * Pick how many nodes go in each of the 4 layers based on the SPREAD
 * AXIS dimension — the axis nodes fan out along. For horizontal
 * orientation that's height; for vertical it's width. Pyramid shape:
 * input + output are slimmer than the hidden layers.
 */
function pickLayerCounts(spreadAxis: number): number[] {
  if (spreadAxis < 480) return [7, 12, 12, 6];
  if (spreadAxis < 768) return [9, 16, 16, 8];
  if (spreadAxis < 1100) return [11, 19, 19, 10];
  return [13, 22, 22, 12];
}

/**
 * Heatmap colour for a 0..1 activation. Resting state is NAISI brand
 * blue; activation warms up through cyan → green → yellow → orange →
 * red so a firing node reads like a real NN activation visualisation.
 * Returns rgba string at the given alpha.
 */
type RGB = [number, number, number];
const HEATMAP: Array<[number, RGB]> = [
  [0.00, [106, 130, 255]], // NAISI blue (rest)
  [0.30, [34, 211, 238]],  // cyan
  [0.55, [34, 197, 94]],   // green
  [0.75, [234, 179, 8]],   // yellow
  [0.90, [249, 115, 22]],  // orange
  [1.00, [239, 68, 68]],   // red (peak activation)
];
function heat(t: number, a = 1): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < HEATMAP.length - 1; i++) {
    const [tA, cA] = HEATMAP[i];
    const [tB, cB] = HEATMAP[i + 1];
    if (clamped <= tB) {
      const f = tB === tA ? 0 : (clamped - tA) / (tB - tA);
      const r = Math.round(cA[0] + (cB[0] - cA[0]) * f);
      const g = Math.round(cA[1] + (cB[1] - cA[1]) * f);
      const b = Math.round(cA[2] + (cB[2] - cA[2]) * f);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  }
  const [r, g, b] = HEATMAP[HEATMAP.length - 1][1];
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
