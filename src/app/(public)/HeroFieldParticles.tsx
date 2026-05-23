"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";

/*
  Option 2 — Subtle particle network.

  Inspired by JulianLaval/canvas-particle-network. No layers, no NN
  pretence. Just floating particles with connecting lines drawn
  between any pair within a proximity threshold. Cursor reactivity
  (cursor acts as an attractor / extra particle).

  Monochrome NAISI-blue, low opacity. Reads as "tech / network" feel
  without committing to a specific neural network visualisation. Used
  by countless AI lab and tech landing pages because it's hard to mess
  up.
*/

const PARTICLE_DENSITY = 11000;   // 1 particle per 11000 px²
const PARTICLE_MAX = 100;
const PARTICLE_MIN = 25;
const PARTICLE_SPEED = 0.18;      // px/frame
const CONNECT_DIST = 130;         // px — within this, draw a line
const CURSOR_RADIUS = 180;        // cursor particle's connect range

type Particle = { x: number; y: number; vx: number; vy: number; r: number };

export default function HeroFieldParticles() {
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
    let particles: Particle[] = [];
    let cursorX = -1000;
    let cursorY = -1000;

    const init = () => {
      const count = Math.max(
        PARTICLE_MIN,
        Math.min(PARTICLE_MAX, Math.floor((width * height) / PARTICLE_DENSITY)),
      );
      particles = [];
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: Math.cos(angle) * PARTICLE_SPEED * (0.6 + Math.random() * 0.8),
          vy: Math.sin(angle) * PARTICLE_SPEED * (0.6 + Math.random() * 0.8),
          r: 1.2 + Math.random() * 1.4,
        });
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

    let frame = 0;
    let visible = true;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      // Drift particles
      if (!reduced) {
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          // Wrap-around so the field never empties at the edges.
          if (p.x < -10) p.x = width + 10;
          if (p.x > width + 10) p.x = -10;
          if (p.y < -10) p.y = height + 10;
          if (p.y > height + 10) p.y = -10;
        }
      }

      // Connections — between particles within CONNECT_DIST.
      // Quadratic in particle count, but capped to 100 so worst case
      // is ~5000 pair checks. Each: a couple of arithmetic ops.
      const accent = "106, 130, 255"; // NAISI blue, r,g,b — RGBA built per draw
      ctx.lineCap = "round";
      ctx.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < CONNECT_DIST * CONNECT_DIST) {
            const dist = Math.sqrt(distSq);
            const alpha = (1 - dist / CONNECT_DIST) * 0.22;
            ctx.strokeStyle = `rgba(${accent}, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Cursor virtual particle — connects to nearby real particles
      // with brighter lines for the interaction feel.
      if (!coarse && cursorX > -100) {
        for (const p of particles) {
          const dx = p.x - cursorX;
          const dy = p.y - cursorY;
          const distSq = dx * dx + dy * dy;
          if (distSq < CURSOR_RADIUS * CURSOR_RADIUS) {
            const dist = Math.sqrt(distSq);
            const alpha = (1 - dist / CURSOR_RADIUS) * 0.45;
            ctx.strokeStyle = `rgba(${accent}, ${alpha})`;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(cursorX, cursorY);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
        }
        ctx.lineWidth = 1;
      }

      // Particles themselves
      for (const p of particles) {
        ctx.fillStyle = `rgba(${accent}, 0.65)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      draw();
    } else {
      frame = requestAnimationFrame(draw);
    }

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        visible = entry.isIntersecting;
        if (visible && !frame && !reduced) {
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
      canvas.parentElement?.removeEventListener("mousemove", onMove);
      canvas.parentElement?.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
