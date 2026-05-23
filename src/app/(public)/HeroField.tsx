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
const SPONT_FIRE_MS = 1800;     // mean interval between spontaneous input fires
const CASCADE_INTENSITY_FLOOR = 0.25;
const CASCADE_DEPTH_MAX = 2;
const CASCADE_DECAY = 0.55;
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
    let accent = "#6a82ff";
    let scrollY = 0;

    const readAccent = () => {
      const v = getComputedStyle(canvas).getPropertyValue("--color-accent").trim();
      if (v) accent = v;
    };

    /**
     * Build a feed-forward layout: 4 vertical layers with N nodes each,
     * edges between adjacent layers only. Layer x-positions are fixed
     * fractions of the canvas width; nodes within a layer spaced
     * vertically with a small jitter.
     */
    const init = () => {
      nodes = [];
      edges = [];

      // Layer sizes — input wider than the rest's tail.
      const layerCounts = pickLayerCounts(width, height);
      const layerX = [0.10, 0.36, 0.64, 0.90].map((f) => f * width);

      for (let l = 0; l < LAYER_COUNT; l++) {
        const count = layerCounts[l];
        const padding = height * 0.12;
        const usable = height - padding * 2;
        const step = count > 1 ? usable / (count - 1) : 0;
        for (let i = 0; i < count; i++) {
          const baseY = padding + (count > 1 ? step * i : usable / 2);
          const jitterX = (Math.random() - 0.5) * (width / 60);
          const jitterY = (Math.random() - 0.5) * (step * 0.18);
          const x = layerX[l] + jitterX;
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

      // Edges — each node connects to ~3 of the next layer's nodes.
      // Picks the 3 nearest by vertical position for a less-tangled look.
      for (let l = 0; l < LAYER_COUNT - 1; l++) {
        const src = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l);
        const dst = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l + 1);
        for (const s of src) {
          const sorted = dst
            .map((d) => ({ idx: d.i, dy: Math.abs(d.n.hy - s.n.hy) }))
            .sort((a, b) => a.dy - b.dy)
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

    readAccent();
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
      ctx.lineWidth = 1;
      const baseA = withAlpha(accent, 0.05);

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const a = nodes[e.from];
        const b = nodes[e.to];
        const x1 = a.x;
        const y1 = a.y - parallax;
        const x2 = b.x;
        const y2 = b.y - parallax;

        // Base line — dim
        const edgeAlpha = 0.05 + Math.max(a.activation, b.activation) * 0.32;
        ctx.strokeStyle = edgeAlpha === 0.05 ? baseA : withAlpha(accent, edgeAlpha);
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
            const half = 9;
            ctx.strokeStyle = withAlpha(accent, 0.9 * e.pulse.intensity);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(px - ux * half, py - uy * half);
            ctx.lineTo(px + ux * half, py + uy * half);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
        }
      }

      // Cursor virtual edges (only on hover, only to 3 nearest)
      if (!coarse && cachedCursorNeighbours.length && cursorX > -100) {
        for (let i = 0; i < cachedCursorNeighbours.length; i++) {
          const n = nodes[cachedCursorNeighbours[i]];
          const dx = n.x - cursorX;
          const dy = (n.y - parallax) - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const a = Math.max(0, 0.22 * (1 - dist / 200));
          if (a > 0.01) {
            ctx.strokeStyle = withAlpha(accent, a);
            ctx.beginPath();
            ctx.moveTo(cursorX, cursorY);
            ctx.lineTo(n.x, n.y - parallax);
            ctx.stroke();
          }
        }
      }

      // Nodes — base dot, plus a halo arc if active (no shadowBlur — too slow)
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const renderY = n.y - parallax;

        // Halo for activated nodes (cheaper than shadowBlur)
        if (n.activation > 0.08) {
          const haloAlpha = n.activation * 0.45;
          ctx.fillStyle = withAlpha(accent, haloAlpha);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 4 + n.activation * 6, 0, Math.PI * 2);
          ctx.fill();
        }

        // Core dot
        const radius = 1.6 + n.activation * 1.6;
        const alpha = 0.4 + n.activation * 0.6;
        ctx.fillStyle = withAlpha(accent, alpha);
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
function pickLayerCounts(width: number, _height: number): number[] {
  if (width < 480) return [4, 6, 6, 3];
  if (width < 768) return [5, 8, 8, 4];
  if (width < 1100) return [6, 10, 10, 5];
  return [7, 12, 12, 6];
}

function withAlpha(rgb: string, a: number): string {
  if (rgb.startsWith("#") && rgb.length === 7) {
    const r = parseInt(rgb.slice(1, 3), 16);
    const g = parseInt(rgb.slice(3, 5), 16);
    const b = parseInt(rgb.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return rgb;
}
