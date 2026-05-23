"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroAurora.module.css";

/*
  HeroAurora — a flowing fragment-shader gradient mesh painted onto a
  full-bleed canvas inside the hero. Three colour stops (NAISI blue → cyan
  → deep indigo) advect through fractal noise, with a soft cursor warp.

  Hand-rolled WebGL1: single VAO-less full-screen triangle, single FS.
  GPU-side animation, no per-frame JS allocations after init.

  Fallbacks:
    - No WebGL → renders nothing; the .hero CSS fallback gradient
      shows through.
    - Reduced motion → renders one frame and freezes.
    - prefers-reduced-data / save-data → renders one frame.
*/

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;       // 0..1 in canvas space
uniform float u_mouseActive;

/* 2D hash + value noise (cheap, good enough for atmospheric noise). */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.05;
    a *= 0.5;
  }
  return v;
}

/* Aurora ribbon — a curl/snake of bright band running across the canvas.
   Returns 0..1 intensity. */
float ribbon(vec2 uv, float t, float yCenter, float thickness, float speed) {
  // Domain-warp the y axis so the ribbon snakes.
  float warp = fbm(vec2(uv.x * 1.4 + t * speed, t * 0.15)) * 0.18;
  float dy = uv.y - yCenter - warp;
  return smoothstep(thickness, 0.0, abs(dy));
}

/* Star field — random sparkles from sparse hash threshold. */
float stars(vec2 uv) {
  vec2 g = floor(uv * 240.0);
  float h = hash(g);
  // Only the top 0.5% of grid cells become a star.
  float s = smoothstep(0.997, 1.0, h);
  // Twinkle by modulating with a slow per-cell sine.
  float twk = 0.5 + 0.5 * sin(u_time * 1.8 + h * 37.0);
  return s * (0.4 + 0.6 * twk);
}

void main() {
  float t = u_time;
  vec2 uv = v_uv;
  // Slight aspect correction so ribbons read the same on widescreen.
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 auv = vec2(uv.x * aspect, uv.y);

  /* Cursor-warp: bend the uv space toward the cursor with falloff. */
  vec2 mouseWorld = vec2(u_mouse.x * aspect, u_mouse.y);
  vec2 toMouse = mouseWorld - auv;
  float md = length(toMouse);
  float warpAmt = smoothstep(0.5, 0.0, md) * u_mouseActive * 0.06;
  auv += normalize(toMouse + 1e-5) * warpAmt;

  /* Domain-warped base flow — slow, drifting noise field. */
  vec2 q = auv * 1.4;
  q.x += t * 0.025;
  q.y -= t * 0.018;
  float base = fbm(q + vec2(fbm(q * 1.6 + t * 0.04), fbm(q * 1.6 - t * 0.04)));

  /* Two aurora ribbons at different heights + speeds. */
  float r1 = ribbon(auv, t, 0.42, 0.22, 0.18);
  float r2 = ribbon(auv, t * 0.85 + 3.7, 0.66, 0.28, -0.13);
  float ribbons = max(r1 * 0.85, r2 * 0.65);

  /* Palette — NAISI blue (#6a82ff), cyan (#5fd1e8), deep indigo (#1a1f4c). */
  vec3 indigo = vec3(0.103, 0.137, 0.298);
  vec3 naisi  = vec3(0.416, 0.510, 1.000);
  vec3 cyan   = vec3(0.373, 0.820, 0.910);
  vec3 violet = vec3(0.500, 0.350, 0.950);

  vec3 col = indigo;
  col = mix(col, naisi,  smoothstep(0.20, 0.62, base));
  col = mix(col, violet, smoothstep(0.55, 0.85, base) * 0.4);
  col = mix(col, cyan,   ribbons * 0.85);

  /* Hot core inside the ribbons — pulses on a slow sine. */
  float pulse = 0.55 + 0.45 * sin(t * 0.4);
  col += vec3(0.18, 0.22, 0.35) * ribbons * pulse;

  /* Cursor spotlight — bright soft disc following the cursor. */
  float spot = smoothstep(0.32, 0.0, md) * u_mouseActive;
  col += vec3(0.12, 0.18, 0.32) * spot;

  /* Stars layer — fine sparkle underneath, gated by darkness so they pop
     only where the colour is dark. */
  float starMask = (1.0 - smoothstep(0.0, 0.35, base)) * 0.85;
  col += vec3(0.9, 0.95, 1.0) * stars(uv) * starMask;

  /* Vignette — soft fade toward the edges so the centre is the show. */
  float vig = smoothstep(1.05, 0.25, distance(uv, vec2(0.5, 0.45)));
  col *= mix(0.55, 1.05, vig);

  /* Subtle hue shift in the lower right for depth. */
  col *= 1.0 + (uv.x - 0.5) * 0.05;

  /* Tonemap-ish soft saturate so colours don't blow out. */
  col = col / (col + vec3(1.0)) * 1.4;

  gl_FragColor = vec4(col, 0.92);
}
`;

export default function HeroAurora() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", { alpha: true, antialias: false });
    if (!gl) {
      // Quietly bail — the .hero CSS fallback gradient shows through.
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData =
      // @ts-expect-error connection is non-standard
      (navigator.connection && navigator.connection.saveData) ||
      window.matchMedia("(prefers-reduced-data: reduce)").matches;

    const compile = (src: string, type: number) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        // Compile failure — bail silently and let the CSS fallback show.
        return null;
      }
      return sh;
    };
    const vs = compile(VERT_SRC, gl.VERTEX_SHADER);
    const fs = compile(FRAG_SRC, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    // Full-screen triangle (covers viewport with one triangle, cheaper than quad).
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "u_time");
    const uRes = gl.getUniformLocation(program, "u_resolution");
    const uMouse = gl.getUniformLocation(program, "u_mouse");
    const uMouseActive = gl.getUniformLocation(program, "u_mouseActive");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let mouseX = 0.5;
    let mouseY = 0.5;
    let targetMouseX = 0.5;
    let targetMouseY = 0.5;
    let mouseActive = 0;

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      targetMouseX = (e.clientX - rect.left) / rect.width;
      targetMouseY = 1 - (e.clientY - rect.top) / rect.height; // GL Y is up
      mouseActive = 1;
    };
    const onLeave = () => {
      mouseActive = 0;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    canvas.parentElement?.addEventListener("mousemove", onMove);
    canvas.parentElement?.addEventListener("mouseleave", onLeave);

    let frame = 0;
    let running = true;
    const start = performance.now();

    const render = (t: number) => {
      if (!running) return;
      const time = (t - start) / 1000;
      mouseX += (targetMouseX - mouseX) * 0.08;
      mouseY += (targetMouseY - mouseY) * 0.08;
      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.uniform1f(uMouseActive, mouseActive);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduced && !saveData) frame = requestAnimationFrame(render);
    };

    // IntersectionObserver pause: only render when the hero is visible.
    let visible = true;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
          if (visible && !frame && !reduced && !saveData) {
            frame = requestAnimationFrame(render);
          } else if (!visible && frame) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
        }
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    frame = requestAnimationFrame(render);

    return () => {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      canvas.parentElement?.removeEventListener("mousemove", onMove);
      canvas.parentElement?.removeEventListener("mouseleave", onLeave);
      gl.deleteBuffer(posBuf);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
