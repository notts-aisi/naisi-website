"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";

/*
  HeroField — canvas-2D neural-activation field.

  Nodes drift via damped random walk. Each node has 2-3 nearest-neighbour
  edges. Pulses *travel* along edges (not just brighten endpoints): when a
  node fires, a moving bright segment animates along each outgoing edge,
  firing the target node on arrival.

  The cursor acts as a virtual node that connects to the nearest 2-3 real
  nodes. Moving through the field triggers activations at nodes it passes
  close to.

  IntersectionObserver pauses the rAF loop when the hero is off-screen.
  prefers-reduced-motion paints one static frame and freezes.
*/

type Pulse = { progress: number; intensity: number };
type Edge = { to: number; pulses: Pulse[] };
type Node = {
  x: number; y: number;
  vx: number; vy: number;
  hx: number; hy: number;       // home position for restoring force
  edges: Edge[];
  activation: number;            // 0..1
  lastFireAt: number;
};

const NODE_BUDGET_DIV = 12000;
const NODE_MAX = 80;
const NODE_MIN = 24;
const EDGES_PER_NODE = 3;
const PULSE_TRAVEL_MS = 600;
const SPONTANEOUS_FIRE_PROB_PER_3500MS = 1;
const CURSOR_FIRE_DIST_PX = 60;
const CURSOR_FIRE_COOLDOWN_MS = 350;

export default function HeroField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0;
    let height = 0;
    let nodes: Node[] = [];
    let accent = "#6a82ff";
    let scrollY = 0;

    const readAccent = () => {
      const v = getComputedStyle(canvas).getPropertyValue("--color-accent").trim();
      if (v) accent = v;
    };

    const init = () => {
      const count = Math.max(NODE_MIN, Math.min(NODE_MAX, Math.floor((width * height) / NODE_BUDGET_DIV)));
      nodes = [];
      const cols = Math.ceil(Math.sqrt((count * width) / height));
      const rows = Math.ceil(count / cols);
      const dx = width / cols;
      const dy = height / rows;
      for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const jitterX = (Math.random() - 0.5) * dx * 0.6;
        const jitterY = (Math.random() - 0.5) * dy * 0.6;
        const x = (col + 0.5) * dx + jitterX;
        const y = (row + 0.5) * dy + jitterY;
        nodes.push({
          x, y, vx: 0, vy: 0,
          hx: x, hy: y,
          edges: [],
          activation: 0,
          lastFireAt: 0,
        });
      }
      // Connect each node to nearest N neighbours.
      for (let i = 0; i < nodes.length; i++) {
        const ni = nodes[i];
        const dists: { idx: number; d: number }[] = [];
        for (let j = 0; j < nodes.length; j++) {
          if (j === i) continue;
          const nj = nodes[j];
          const ddx = ni.hx - nj.hx;
          const ddy = ni.hy - nj.hy;
          dists.push({ idx: j, d: ddx * ddx + ddy * ddy });
        }
        dists.sort((a, b) => a.d - b.d);
        for (let k = 0; k < Math.min(EDGES_PER_NODE, dists.length); k++) {
          // Avoid duplicate edges in either direction (treat as directed for pulses
          // but visually it's the same line).
          ni.edges.push({ to: dists[k].idx, pulses: [] });
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

    // Cursor handling
    let cursorX = -1000;
    let cursorY = -1000;
    let lastCursorFireAt = -Infinity;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursorX = e.clientX - rect.left;
      cursorY = e.clientY - rect.top;
    };
    const onLeave = () => {
      cursorX = -1000;
      cursorY = -1000;
    };
    if (!coarse) {
      canvas.parentElement?.addEventListener("mousemove", onMove);
      canvas.parentElement?.addEventListener("mouseleave", onLeave);
    }

    // Scroll listener — passive
    const onScroll = () => { scrollY = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Atmosphere gate — don't fire activations until headline has settled (~3000ms).
    const startMs = performance.now();
    const ATMOSPHERE_GATE_MS = 3000;

    let lastT = performance.now();
    let frame = 0;
    let visible = true;

    const fireNode = (idx: number, intensity = 1) => {
      const n = nodes[idx];
      if (!n) return;
      n.activation = Math.min(1, intensity);
      n.lastFireAt = performance.now();
      for (const edge of n.edges) {
        edge.pulses.push({ progress: 0, intensity });
      }
    };

    const draw = (now: number) => {
      const dt = Math.min(33, now - lastT);
      lastT = now;
      const sinceStart = now - startMs;
      const atmosphereOn = sinceStart > ATMOSPHERE_GATE_MS;

      ctx.clearRect(0, 0, width, height);

      const parallax = scrollY * 0.15;

      // Update node positions
      for (const n of nodes) {
        if (!reduced) {
          n.vx += (Math.random() - 0.5) * 0.02;
          n.vy += (Math.random() - 0.5) * 0.02;
          n.vx *= 0.96;
          n.vy *= 0.96;
          n.vx += (n.hx - n.x) * 0.001;
          n.vy += (n.hy - n.y) * 0.001;
          n.x += n.vx;
          n.y += n.vy;
        }
        n.activation *= 0.96;
      }

      // Cursor virtual edges — connect to nearest 3 nodes
      let cursorNeighbours: number[] = [];
      if (!coarse && cursorX > -100 && cursorY > -100) {
        const ds = nodes.map((nn, i) => ({
          i,
          d: (nn.x - cursorX) ** 2 + (nn.y - cursorY) ** 2,
        }));
        ds.sort((a, b) => a.d - b.d);
        cursorNeighbours = ds.slice(0, 3).map((x) => x.i);
        // Fire the nearest node if close enough
        if (ds[0].d < CURSOR_FIRE_DIST_PX * CURSOR_FIRE_DIST_PX
            && atmosphereOn
            && now - lastCursorFireAt > CURSOR_FIRE_COOLDOWN_MS) {
          fireNode(ds[0].i, 0.8);
          lastCursorFireAt = now;
        }
      }

      // Spontaneous fires
      if (atmosphereOn && !reduced) {
        if (Math.random() < (dt / 3500) * SPONTANEOUS_FIRE_PROB_PER_3500MS) {
          fireNode(Math.floor(Math.random() * nodes.length), 0.9);
        }
      }

      // Advance pulses + draw edges with pulse highlights
      ctx.lineCap = "round";
      for (const n of nodes) {
        for (const e of n.edges) {
          const t = nodes[e.to];
          const x1 = n.x;
          const y1 = n.y - parallax;
          const x2 = t.x;
          const y2 = t.y - parallax;

          // Base edge line
          const baseAlpha = 0.06 + Math.max(n.activation, t.activation) * 0.32;
          ctx.strokeStyle = withAlpha(accent, baseAlpha);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Pulses travelling along
          if (!reduced) {
            for (let p = e.pulses.length - 1; p >= 0; p--) {
              const pulse = e.pulses[p];
              pulse.progress += dt / PULSE_TRAVEL_MS;
              if (pulse.progress >= 1) {
                // Pulse arrives — fire target
                fireNode(e.to, pulse.intensity * 0.7);
                e.pulses.splice(p, 1);
                continue;
              }
              // Draw a short bright segment around the pulse position
              const px = x1 + (x2 - x1) * pulse.progress;
              const py = y1 + (y2 - y1) * pulse.progress;
              const halfLen = 8;
              const dx2 = x2 - x1;
              const dy2 = y2 - y1;
              const len = Math.hypot(dx2, dy2) || 1;
              const ux = dx2 / len;
              const uy = dy2 / len;
              ctx.strokeStyle = withAlpha(accent, 0.85 * pulse.intensity);
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(px - ux * halfLen, py - uy * halfLen);
              ctx.lineTo(px + ux * halfLen, py + uy * halfLen);
              ctx.stroke();
            }
          }
        }
      }

      // Cursor's virtual edges
      if (!coarse && cursorNeighbours.length) {
        for (const i of cursorNeighbours) {
          const nn = nodes[i];
          const dx2 = nn.x - cursorX;
          const dy2 = nn.y - (cursorY + parallax);
          const dist = Math.hypot(dx2, dy2);
          const alpha = Math.max(0, 0.18 * (1 - dist / 220));
          if (alpha > 0.01) {
            ctx.strokeStyle = withAlpha(accent, alpha);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cursorX, cursorY);
            ctx.lineTo(nn.x, nn.y - parallax);
            ctx.stroke();
          }
        }
      }

      // Nodes
      for (const n of nodes) {
        const radius = 1.4 + n.activation * 2.0;
        const alpha = 0.35 + n.activation * 0.65;
        ctx.fillStyle = withAlpha(accent, alpha);
        if (n.activation > 0.05) {
          ctx.shadowColor = withAlpha(accent, 0.6);
          ctx.shadowBlur = n.activation * 14;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y - parallax, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      // Single static frame with low-activation nodes for the freeze.
      for (const n of nodes) n.activation = 0.3;
      draw(performance.now());
    } else {
      frame = requestAnimationFrame(draw);
    }

    // Pause when hero leaves view
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

function withAlpha(rgb: string, a: number): string {
  // Accept #RRGGBB and produce rgba(). Accent token in this codebase is hex.
  if (rgb.startsWith("#") && rgb.length === 7) {
    const r = parseInt(rgb.slice(1, 3), 16);
    const g = parseInt(rgb.slice(3, 5), 16);
    const b = parseInt(rgb.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return rgb;
}
