"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";

/*
  Option 4 — Subtle traveling impulses (towc-style).

  Layered NN structure preserved, but the rendering is calmed down:
    - Small dots travel along edges (no bright streaks, no white core)
    - Per-node base tint varies slightly (subtle randomness — not rainbow)
    - Monochrome NAISI accent palette, just brighter when active
    - Slower decay so the wave is watchable

  Cousin of HeroField but with the visual loud-pedal off.
*/

const LAYER_COUNT = 4;
const PULSE_TRAVEL_MS = 1100;
const SPONT_WAVE_MS = 4800;
const INPUT_STAGGER_MS = 70;
const CASCADE_DECAY = 0.78;
const CASCADE_DEPTH_MAX = 3;
const CASCADE_FLOOR = 0.18;
const ACTIVATION_DECAY = 0.97;

type Pulse = { progress: number; intensity: number; depth: number };
type Edge = { from: number; to: number; pulse: Pulse | null };
type Node = {
  x: number; y: number;
  vx: number; vy: number;
  hx: number; hy: number;
  layer: number;
  outEdges: number[];
  /** Slight per-node colour tint variance — 0 to 1, applied as hue offset. */
  tint: number;
  activation: number;
};

export default function HeroFieldImpulses() {
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

    const nodeColor = (n: Node, alpha: number): string => {
      // Base NAISI accent hue (220) with a small per-node offset ±15.
      const hue = 220 + (n.tint - 0.5) * 30;
      const sat = 75 + n.activation * 20;
      const light = 50 + n.activation * 25;
      return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
    };

    const init = () => {
      nodes = [];
      edges = [];
      const vertical = width < height || width < 600;
      const layerCounts = vertical
        ? width < 480 ? [6, 10, 10, 5] : [9, 14, 14, 8]
        : height < 480 ? [7, 12, 12, 6] : [11, 17, 17, 9];
      const layerFractions = [0.12, 0.38, 0.64, 0.90];

      for (let l = 0; l < LAYER_COUNT; l++) {
        const count = layerCounts[l];
        if (vertical) {
          const pad = width * 0.10;
          const usable = width - pad * 2;
          const step = count > 1 ? usable / (count - 1) : 0;
          const yPos = layerFractions[l] * height;
          for (let i = 0; i < count; i++) {
            const baseX = pad + (count > 1 ? step * i : usable / 2);
            const jY = (Math.random() - 0.5) * (height / 70);
            const jX = (Math.random() - 0.5) * (step * 0.18);
            nodes.push({
              x: baseX + jX, y: yPos + jY, vx: 0, vy: 0,
              hx: baseX + jX, hy: yPos + jY,
              layer: l, outEdges: [],
              tint: Math.random(),
              activation: 0,
            });
          }
        } else {
          const pad = height * 0.12;
          const usable = height - pad * 2;
          const step = count > 1 ? usable / (count - 1) : 0;
          const xPos = layerFractions[l] * width;
          for (let i = 0; i < count; i++) {
            const baseY = pad + (count > 1 ? step * i : usable / 2);
            const jX = (Math.random() - 0.5) * (width / 70);
            const jY = (Math.random() - 0.5) * (step * 0.18);
            nodes.push({
              x: xPos + jX, y: baseY + jY, vx: 0, vy: 0,
              hx: xPos + jX, hy: baseY + jY,
              layer: l, outEdges: [],
              tint: Math.random(),
              activation: 0,
            });
          }
        }
      }

      const v = width < height || width < 600;
      for (let l = 0; l < LAYER_COUNT - 1; l++) {
        const src = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l);
        const dst = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l + 1);
        for (const s of src) {
          const sorted = dst
            .map((d) => ({
              idx: d.i,
              d: v ? Math.abs(d.n.hx - s.n.hx) : Math.abs(d.n.hy - s.n.hy),
            }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 3);
          for (const d of sorted) {
            const eIdx = edges.length;
            edges.push({ from: s.i, to: d.idx, pulse: null });
            s.n.outEdges.push(eIdx);
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

    let cursorX = -1000;
    let cursorY = -1000;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursorX = e.clientX - rect.left;
      cursorY = e.clientY - rect.top;
    };
    const onLeave = () => { cursorX = -1000; cursorY = -1000; };
    if (!coarse) {
      canvas.parentElement?.addEventListener("mousemove", onMove);
      canvas.parentElement?.addEventListener("mouseleave", onLeave);
    }
    const onScroll = () => { scrollY = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });

    const startMs = performance.now();
    const ATMOSPHERE_GATE_MS = 2500;
    let lastT = performance.now();
    let lastWaveAt = startMs;
    let pendingInputFires: Array<{ fireAt: number; nodeIdx: number }> = [];
    let frame = 0;
    let visible = true;
    let lastCursorFireAt = -Infinity;

    const fireNode = (idx: number, intensity = 1, depth = 0) => {
      if (intensity < CASCADE_FLOOR) return;
      const n = nodes[idx];
      if (!n) return;
      if (depth > CASCADE_DEPTH_MAX) {
        n.activation = Math.max(n.activation, intensity);
        return;
      }
      n.activation = Math.max(n.activation, intensity);
      for (const eIdx of n.outEdges) {
        const e = edges[eIdx];
        if (!e || e.pulse) continue;
        e.pulse = { progress: 0, intensity, depth };
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(33, now - lastT);
      lastT = now;
      const parallax = scrollY * 0.12;
      const atmosphereOn = now - startMs > ATMOSPHERE_GATE_MS;

      ctx.clearRect(0, 0, width, height);

      if (!reduced) {
        for (const n of nodes) {
          n.vx += (Math.random() - 0.5) * 0.012;
          n.vy += (Math.random() - 0.5) * 0.012;
          n.vx *= 0.93;
          n.vy *= 0.93;
          n.vx += (n.hx - n.x) * 0.0015;
          n.vy += (n.hy - n.y) * 0.0015;
          n.x += n.vx;
          n.y += n.vy;
          n.activation *= ACTIVATION_DECAY;
        }
      }

      // Wave: stagger fire across input layer
      if (atmosphereOn && !reduced && now - lastWaveAt > SPONT_WAVE_MS) {
        const inputNodes: number[] = [];
        for (let i = 0; i < nodes.length; i++) if (nodes[i].layer === 0) inputNodes.push(i);
        for (let i = inputNodes.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [inputNodes[i], inputNodes[j]] = [inputNodes[j], inputNodes[i]];
        }
        for (let k = 0; k < inputNodes.length; k++) {
          pendingInputFires.push({
            fireAt: now + k * INPUT_STAGGER_MS,
            nodeIdx: inputNodes[k],
          });
        }
        lastWaveAt = now;
      }
      // Drain pending
      let pi = 0;
      while (pi < pendingInputFires.length) {
        if (pendingInputFires[pi].fireAt <= now) {
          fireNode(pendingInputFires[pi].nodeIdx, 0.9);
          pendingInputFires.splice(pi, 1);
        } else {
          pi++;
        }
      }

      // Cursor fire on hover
      if (!coarse && cursorX > -100 && atmosphereOn) {
        let bestI = -1;
        let bestD = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          const dx = nodes[i].x - cursorX;
          const dy = nodes[i].y - cursorY;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0 && bestD < 65 * 65 && now - lastCursorFireAt > 600) {
          fireNode(bestI, 0.85);
          lastCursorFireAt = now;
        }
      }

      // Edges + pulses
      ctx.lineCap = "round";
      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[e.from];
        const b = nodes[e.to];
        const x1 = a.x;
        const y1 = a.y - parallax;
        const x2 = b.x;
        const y2 = b.y - parallax;

        const activeMax = Math.max(a.activation, b.activation);
        const baseAlpha = 0.09 + activeMax * 0.35;
        ctx.strokeStyle = nodeColor(activeMax > a.activation ? b : a, baseAlpha);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Pulse rendered as a SMALL DOT travelling along the edge.
        // No streak, no white core — just a brighter dot than the edge.
        if (e.pulse && !reduced) {
          e.pulse.progress += dt / PULSE_TRAVEL_MS;
          if (e.pulse.progress >= 1) {
            const arrivingI = e.pulse.intensity * CASCADE_DECAY;
            const arrivingD = e.pulse.depth + 1;
            const tIdx = e.to;
            e.pulse = null;
            fireNode(tIdx, arrivingI, arrivingD);
          } else {
            const px = x1 + (x2 - x1) * e.pulse.progress;
            const py = y1 + (y2 - y1) * e.pulse.progress;
            // Small dot (radius 2.2), coloured at the pulse intensity
            const tintNode = { ...b, activation: e.pulse.intensity };
            ctx.fillStyle = nodeColor(tintNode, 0.95);
            ctx.beginPath();
            ctx.arc(px, py, 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Cursor virtual edges
      if (!coarse && cursorX > -100) {
        for (const n of nodes) {
          const dx = n.x - cursorX;
          const dy = (n.y - parallax) - cursorY;
          const distSq = dx * dx + dy * dy;
          if (distSq < 200 * 200) {
            const dist = Math.sqrt(distSq);
            const a = Math.max(0, 0.2 * (1 - dist / 200));
            if (a > 0.02) {
              ctx.strokeStyle = nodeColor(n, a);
              ctx.beginPath();
              ctx.moveTo(cursorX, cursorY);
              ctx.lineTo(n.x, n.y - parallax);
              ctx.stroke();
            }
          }
        }
      }

      // Nodes
      for (const n of nodes) {
        const rY = n.y - parallax;
        if (n.activation > 0.08) {
          ctx.fillStyle = nodeColor(n, n.activation * 0.4);
          ctx.beginPath();
          ctx.arc(n.x, rY, 5 + n.activation * 8, 0, Math.PI * 2);
          ctx.fill();
        }
        const r = 1.8 + n.activation * 1.6;
        ctx.fillStyle = nodeColor(n, 0.55 + n.activation * 0.4);
        ctx.beginPath();
        ctx.arc(n.x, rY, r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      for (const n of nodes) n.activation = 0.3;
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
