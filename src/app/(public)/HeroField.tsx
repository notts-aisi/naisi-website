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
const PULSE_TRAVEL_MS = 950;          // slower so the wave is watchable
const SPONT_WAVE_MS = 5500;           // gap between full fill-up waves
const INPUT_WAVE_STAGGER_MS = 55;     // input nodes fire in a tight stagger, not all at once
const CASCADE_INTENSITY_FLOOR = 0.14; // low floor so the wave reaches the output layer
const CASCADE_DEPTH_MAX = 3;          // full propagation: input → output
const CASCADE_DECAY = 0.9;            // very little decay per hop — keeps the rainbow vivid
const ACTIVATION_DECAY = 0.985;       // slow per-frame fade so trails persist after the wave
const CURSOR_RECOMPUTE_PX = 8;
const CURSOR_FIRE_COOLDOWN_MS = 500;
const CURSOR_FIRE_DIST = 70;

/*
  Per-layer HUE assignment (violet → blue → green → orange-red). Each
  node's colour comes from its LAYER, not its activation level. So when
  the wave fills the network you see a genuine rainbow stretched across
  it (input violet, output orange-red). Activation drives brightness +
  saturation: dim at rest, electric at peak.
*/
const LAYER_HUE: number[] = [275, 200, 80, 10];

function layerColor(layer: number, activation: number, alpha: number): string {
  const hue = LAYER_HUE[Math.min(layer, LAYER_HUE.length - 1)];
  const sat = 70 + activation * 25;
  const light = 38 + activation * 30;
  return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}

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
    let lastWaveAt = startMs;
    // Pending input fires queued for the current wave. Each wave fires
    // every input-layer node in sequence (tight stagger ~55ms apart) so
    // the leading edge of the rainbow forms across the input layer.
    const pendingInputFires: Array<{ fireAt: number; nodeIdx: number }> = [];
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

      // Drift nodes + slow activation decay (so the fill leaves a fading trail).
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
          n.activation *= ACTIVATION_DECAY;
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

      // Wave: queue every input-layer node to fire in a tight stagger.
      // This makes the leading edge of the propagation feel like a wide
      // wave hitting all of layer 0 at once, which then cascades right.
      if (atmosphereOn && !reduced && now - lastWaveAt > SPONT_WAVE_MS) {
        const inputNodes: number[] = [];
        for (let i = 0; i < nodes.length; i++) if (nodes[i].layer === 0) inputNodes.push(i);
        // Shuffle so the stagger doesn't always march along the y-axis.
        for (let i = inputNodes.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [inputNodes[i], inputNodes[j]] = [inputNodes[j], inputNodes[i]];
        }
        for (let k = 0; k < inputNodes.length; k++) {
          pendingInputFires.push({
            fireAt: now + k * INPUT_WAVE_STAGGER_MS,
            nodeIdx: inputNodes[k],
          });
        }
        lastWaveAt = now;
      }
      // Drain pending input fires whose time has come.
      if (pendingInputFires.length) {
        let i = 0;
        while (i < pendingInputFires.length) {
          if (pendingInputFires[i].fireAt <= now) {
            fireNode(pendingInputFires[i].nodeIdx, 0.95);
            pendingInputFires.splice(i, 1);
          } else {
            i++;
          }
        }
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

        // Edge colour = layer colour of the brighter endpoint. At rest
        // the edges are dim layer-tinted lines; when nodes fire the
        // edges glow in the source layer's rainbow hue.
        const endpointMax = Math.max(a.activation, b.activation);
        const brighterNode = a.activation >= b.activation ? a : b;
        const edgeAlpha = 0.14 + endpointMax * 0.6;
        ctx.strokeStyle = layerColor(brighterNode.layer, endpointMax, edgeAlpha);
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
            const half = 14;
            // Pulse carries the destination layer's colour — the wave
            // is "becoming" the next layer's hue as it arrives. Adds a
            // bright white-hot core so it reads like a spark.
            const intensity = e.pulse.intensity;
            ctx.strokeStyle = layerColor(b.layer, intensity, 1.0);
            ctx.lineWidth = 3.0;
            ctx.beginPath();
            ctx.moveTo(px - ux * half, py - uy * half);
            ctx.lineTo(px + ux * half, py + uy * half);
            ctx.stroke();
            // White-hot core — narrower segment at the leading edge of
            // the pulse for that "arc of electricity" feel.
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * intensity})`;
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.moveTo(px - ux * (half - 5), py - uy * (half - 5));
            ctx.lineTo(px + ux * (half - 5), py + uy * (half - 5));
            ctx.stroke();
            ctx.lineWidth = 1.2;
          }
        }
      }

      // Cursor virtual edges (only on hover, only to 3 nearest).
      // Coloured by the nearest node's LAYER so each link picks up the
      // rainbow position of the node it touches.
      if (!coarse && cachedCursorNeighbours.length && cursorX > -100) {
        for (let i = 0; i < cachedCursorNeighbours.length; i++) {
          const n = nodes[cachedCursorNeighbours[i]];
          const dx = n.x - cursorX;
          const dy = (n.y - parallax) - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const a = Math.max(0, 0.22 * (1 - dist / 200));
          if (a > 0.01) {
            ctx.strokeStyle = layerColor(n.layer, Math.max(0.35, n.activation), a);
            ctx.beginPath();
            ctx.moveTo(cursorX, cursorY);
            ctx.lineTo(n.x, n.y - parallax);
            ctx.stroke();
          }
        }
      }

      // Nodes — base dot + halo if active. Colour by LAYER (rainbow
      // across the network); activation drives brightness + saturation.
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const renderY = n.y - parallax;

        // Outer + inner halo for activated nodes — gives the "electric
        // glow" feel without paying for shadowBlur.
        if (n.activation > 0.06) {
          const haloAlpha = n.activation * 0.6;
          ctx.fillStyle = layerColor(n.layer, n.activation, haloAlpha * 0.45);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 8 + n.activation * 14, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = layerColor(n.layer, n.activation, haloAlpha);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 3 + n.activation * 6, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core dot — always layer-coloured. Dim at rest, electric when
        // the wave is passing through.
        const radius = 2 + n.activation * 2;
        const alpha = 0.5 + n.activation * 0.5;
        ctx.fillStyle = layerColor(n.layer, n.activation, alpha);
        ctx.beginPath();
        ctx.arc(n.x, renderY, radius, 0, Math.PI * 2);
        ctx.fill();

        // White-hot core inside fully-firing nodes (peak of the wave).
        if (n.activation > 0.5) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(n.activation - 0.5) * 0.8})`;
          ctx.beginPath();
          ctx.arc(n.x, renderY, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      // Static frame: every node at mid activation so the rainbow is
      // visible at rest. No animation, no pulses, no decay.
      for (const n of nodes) n.activation = 0.55;
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

// layerColor() (defined near the top, with LAYER_HUE) is the only
// colour generator now — superseded the old activation-heatmap.
