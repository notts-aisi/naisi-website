"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";

/*
  Option 1 — TensorFlow Playground style.

  Each node has a base "value" in [-1, +1] that drifts slowly. Colour
  diverges: orange for negative, blue for positive, white at zero.
  Connection weight colours match. Activation waves amplify values
  briefly, then decay.

  No moving impulses, no rainbow, no spark effects. Just neurons whose
  colour-and-intensity tells you what they're doing — like the
  reference at https://playground.tensorflow.org.

  Adapts the layered structure from HeroField but replaces the rendering
  logic entirely.
*/

const LAYER_COUNT = 4;
const ACTIVATION_DECAY = 0.985;
const WAVE_INTERVAL_MS = 6000;
const VALUE_DRIFT_PER_FRAME = 0.0012;

type Node = {
  x: number; y: number;
  vx: number; vy: number;
  hx: number; hy: number;
  layer: number;
  outEdges: number[];
  /** Base value in [-1, +1]. Drifts slowly. */
  value: number;
  /** 0..1. Multiplied with value for displayed intensity. */
  activation: number;
};
type Edge = {
  from: number;
  to: number;
  /** Connection weight in [-1, +1]. Sign drives colour, magnitude drives alpha + thickness. */
  weight: number;
};

function valueColor(value: number, activation: number, alpha: number): string {
  // Magnitude in [0, 1] = how saturated. Sign drives which colour.
  const intensity = Math.min(1, Math.abs(value) * (0.45 + activation * 0.65));
  if (value >= 0) {
    // Blue (positive). hue 215.
    return `hsla(215, 90%, ${50 + intensity * 18}%, ${alpha * (0.35 + intensity * 0.65)})`;
  } else {
    // Orange (negative). hue 25.
    return `hsla(25, 95%, ${52 + intensity * 16}%, ${alpha * (0.35 + intensity * 0.65)})`;
  }
}

export default function HeroFieldTfStyle() {
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

    const init = () => {
      nodes = [];
      edges = [];
      const vertical = width < height || width < 600;
      const layerCounts = vertical
        ? width < 480 ? [6, 9, 9, 5] : [8, 12, 12, 7]
        : height < 480 ? [6, 10, 10, 5] : [9, 14, 14, 8];
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
            const jY = (Math.random() - 0.5) * (height / 80);
            const jX = (Math.random() - 0.5) * (step * 0.2);
            nodes.push({
              x: baseX + jX, y: yPos + jY, vx: 0, vy: 0,
              hx: baseX + jX, hy: yPos + jY,
              layer: l, outEdges: [],
              value: (Math.random() * 2 - 1) * 0.8,
              activation: 0.25 + Math.random() * 0.25,
            });
          }
        } else {
          const pad = height * 0.12;
          const usable = height - pad * 2;
          const step = count > 1 ? usable / (count - 1) : 0;
          const xPos = layerFractions[l] * width;
          for (let i = 0; i < count; i++) {
            const baseY = pad + (count > 1 ? step * i : usable / 2);
            const jX = (Math.random() - 0.5) * (width / 80);
            const jY = (Math.random() - 0.5) * (step * 0.2);
            nodes.push({
              x: xPos + jX, y: baseY + jY, vx: 0, vy: 0,
              hx: xPos + jX, hy: baseY + jY,
              layer: l, outEdges: [],
              value: (Math.random() * 2 - 1) * 0.8,
              activation: 0.25 + Math.random() * 0.25,
            });
          }
        }
      }

      // Edges: each source connects to 3 nearest of next layer.
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
            edges.push({
              from: s.i,
              to: d.idx,
              weight: (Math.random() * 2 - 1) * 0.9,
            });
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

    // Cursor tracking (for hover-triggered activation)
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

    let lastT = performance.now();
    let lastWaveAt = performance.now();
    let frame = 0;
    let visible = true;

    /**
     * Trigger a wave: amplify activation across the input layer, then
     * forward through edges with each node's activation being the
     * weighted sum of its inputs' activations × edge weight.
     */
    const fireWave = () => {
      // Step 1: input layer activations spike.
      for (const n of nodes) {
        if (n.layer === 0) {
          n.activation = 1;
        }
      }
      // Step 2: propagate forward. Each non-input node accumulates a
      // weighted activation from incoming edges of the previous layer.
      // We do this all at once (synchronous), then a slower decay over
      // many frames creates the "fade" feel.
      for (let l = 1; l < LAYER_COUNT; l++) {
        const layerNodes = nodes
          .map((n, i) => ({ n, i }))
          .filter((x) => x.n.layer === l);
        for (const { n: dst, i: dstIdx } of layerNodes) {
          let sum = 0;
          let inputs = 0;
          for (const e of edges) {
            if (e.to !== dstIdx) continue;
            const src = nodes[e.from];
            sum += src.activation * e.weight;
            inputs++;
          }
          if (inputs > 0) {
            // tanh-like clamp into [-1, +1] then map to [0, 1] activation
            // with sign captured by `value`.
            const out = Math.tanh(sum);
            dst.activation = Math.abs(out);
            // Slowly nudge value toward signal direction so visible
            // colour reflects the propagation.
            dst.value = dst.value * 0.5 + out * 0.5;
          }
        }
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(33, now - lastT);
      lastT = now;
      const parallax = scrollY * 0.12;

      ctx.clearRect(0, 0, width, height);

      // Drift + decay
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
          // Slowly drift each node's base value so the resting pattern
          // shifts over time.
          n.value += (Math.random() - 0.5) * VALUE_DRIFT_PER_FRAME * dt;
          if (n.value > 1) n.value = 1;
          if (n.value < -1) n.value = -1;
        }
      }

      if (!reduced && now - lastWaveAt > WAVE_INTERVAL_MS) {
        fireWave();
        lastWaveAt = now;
      }

      // Cursor hover triggers a localised wave on the nearest node.
      if (!coarse && cursorX > -100) {
        let bestIdx = -1;
        let bestD = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          const dx = nodes[i].x - cursorX;
          const dy = nodes[i].y - cursorY;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestD < 80 * 80) {
          nodes[bestIdx].activation = Math.max(nodes[bestIdx].activation, 0.9);
        }
      }

      // Draw edges first — coloured by weight, intensity by activation
      // of the brighter endpoint.
      ctx.lineCap = "round";
      for (const e of edges) {
        const a = nodes[e.from];
        const b = nodes[e.to];
        const x1 = a.x;
        const y1 = a.y - parallax;
        const x2 = b.x;
        const y2 = b.y - parallax;
        const activeMax = Math.max(a.activation, b.activation);
        const mag = Math.abs(e.weight);
        const alpha = (0.06 + activeMax * 0.45) * (0.4 + mag * 0.6);
        ctx.strokeStyle = valueColor(e.weight, activeMax, alpha);
        ctx.lineWidth = 0.8 + mag * 1.1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // Draw nodes — value drives colour direction, activation drives glow
      for (const n of nodes) {
        const renderY = n.y - parallax;
        if (n.activation > 0.1) {
          // Soft glow
          ctx.fillStyle = valueColor(n.value, n.activation, n.activation * 0.35);
          ctx.beginPath();
          ctx.arc(n.x, renderY, 6 + n.activation * 10, 0, Math.PI * 2);
          ctx.fill();
        }
        // Core dot
        const r = 2 + Math.abs(n.value) * 1.4 + n.activation * 1.4;
        ctx.fillStyle = valueColor(n.value, n.activation, 0.45 + n.activation * 0.5);
        ctx.beginPath();
        ctx.arc(n.x, renderY, r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
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
