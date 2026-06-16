"use client";

import { useEffect, useRef } from "react";

export const LIVING_W_DEFAULT = 640;
export const LIVING_H_DEFAULT = 110;

const LAYER_HUES = [275, 272, 268, 264, 258, 252, 244, 236, 226, 280, 296, 308, 318, 322, 312, 300, 286, 270, 262, 256, 248, 240];
const PATH_HUES = [275, 250, 232, 300, 320, 268, 295, 285];

// Module-scope so default layerSizes keeps a stable reference across
// re-renders. Inline defaults like `layerSizes = [...]` allocate a NEW
// array on every render → useEffect deps see "changed" → animation
// re-inits → visible jump on parent state changes.
const DEFAULT_LAYER_SIZES: number[] = [2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9, 9, 8, 8, 7, 6, 5, 4, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 3, 3, 3, 2, 2, 2, 3, 3, 4, 3, 2];

export type AttractorMode = "off" | "highlight" | "magnetic" | "ripple" | "comet" | "warp";

export type LivingPlasmaProps = {
  active?: boolean;
  layerSizes?: number[];
  attractor?: AttractorMode;
  /** Magnetic-only: radius (px) within which cursor pulls nodes. */
  magneticPullRadius?: number;
  /** Magnetic-only: max displacement (px) of a node at proximity 1. */
  magneticPullStrength?: number;
  /** When set (performance.now() timestamp), a slow green wavefront
   *  sweeps L→R; nodes it touches lock to green at full brightness
   *  and stay that way. Use to celebrate a successful sign-in. */
  successStartAt?: number | null;
  /** How long the green wave takes to traverse the full canvas (ms). */
  successDurationMs?: number;
  pathCount?: number;
  pulsesPerBurstActive?: number;
  pulsesPerBurstIdle?: number;
  pulseStaggerMs?: number;
  trailLength?: number;
  /** Rings spawned per burst in ACTIVE (the iris fan-out). */
  ringCountActive?: number;
  /** Rings per burst in IDLE — keep at 1 for a single calm pulse. */
  ringCountIdle?: number;
  /** Pulse path travel time in ACTIVE (ms). */
  pathTravelMsActive?: number;
  /** Pulse path travel time in IDLE — bigger = slower. */
  pathTravelMsIdle?: number;
  /** Wave ring speed in ACTIVE (px/s). */
  waveSpeedActive?: number;
  /** Wave ring speed in IDLE — much smaller for calm idle. */
  waveSpeedIdle?: number;
  bloomOriginX?: number;
  /** Y-axis-only synced breath amplitude (base, ACTIVE max). */
  breathingAmplitude?: number;
  /** Fraction of breathingAmplitude used in IDLE (0–1). */
  breathingIdleScale?: number;
  /** Column expansion fraction when wave crosses (base, ACTIVE max). */
  expansionAmplitude?: number;
  /** Fraction of expansionAmplitude used in IDLE (0–1). */
  expansionIdleScale?: number;
  /** Px between adjacent nodes within a layer. */
  rowSpacing?: number;
  width?: number;
  height?: number;
};

type Node = {
  baseX: number;
  baseY: number;
  layer: number;
  rowInLayer: number;
  spreadY: number;
  expansionT: number;
  activation: number;
  cursorOffsetX: number;
  cursorOffsetY: number;
  /** Performance.now() when the success wavefront first passed this
   *  node's x. Null until then. Drives the per-node smooth lock-in. */
  lockStartAt: number | null;
  /** Smoothed (eased) lock progress 0–1: 0 = unaffected, 1 = fully
   *  locked green + activation + zero breath. */
  lockProgress: number;
  /** Activation value at the instant lock started. Used as the FIXED
   *  source endpoint when lerp-ing toward the success target each
   *  frame — anchoring to a fixed reference prevents the per-frame
   *  jiggle that comes from blending against n.activation while it
   *  is decaying naturally. */
  lockInitialActivation: number;
  /** Full position offset from (baseX, baseY) captured at lock-start.
   *  In locked mode the rendered position is purely
   *  baseX + lockInitialOffsetX * (1 - lockProgress) (and similar for
   *  Y) — i.e. we IGNORE live breath/expansion/cursor entirely and
   *  smoothly interpolate the snapshotted offset toward zero. This is
   *  the actual "sink into shape" — a monotonic motion from wherever
   *  the node was to its home position, immune to ongoing sine
   *  oscillations that would otherwise make the path non-monotonic. */
  lockInitialOffsetX: number;
  lockInitialOffsetY: number;
};

type CursorRipple = { x: number; y: number; startAt: number };
type CursorTrailPoint = { x: number; y: number; at: number };

type Path = { nodeIdxs: number[]; hue: number };
type Pulse = { pathIdx: number; startAt: number; travelMs: number; intensity: number; hue: number };
type Wave = {
  startAt: number;
  speed: number;
  hueShift: number;
  intensity: number;
  firedLayers: Set<number>;
};

const ACTIVATION_DECAY = 0.952;
const EASE_DURATION_MS = 1200;
const BURST_INTERVAL_ACTIVE = 1500;
const BURST_INTERVAL_IDLE = 2600;
const RING_SPEED_RATIOS = [0.78, 1.0, 1.25];

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export default function LivingPlasma({
  active = false,
  layerSizes = DEFAULT_LAYER_SIZES,
  attractor = "off",
  magneticPullRadius = 100,
  magneticPullStrength = 15,
  pathCount = 9,
  pulsesPerBurstActive = 7,
  pulsesPerBurstIdle = 2,
  pulseStaggerMs = 110,
  trailLength = 48,
  ringCountActive = 3,
  ringCountIdle = 1,
  // Slowed 30% active, 50% idle from v6 baseline
  pathTravelMsActive = 3900,
  pathTravelMsIdle = 6750,
  waveSpeedActive = 102,
  waveSpeedIdle = 37,
  bloomOriginX = 0,
  breathingAmplitude = 1.6,
  breathingIdleScale = 0.4,
  expansionAmplitude = 0.55,
  expansionIdleScale = 0.35,
  rowSpacing = 10,
  successStartAt = null,
  // ~30% faster green sweep (was 2550) — keep in sync with AuthEntry's
  // SUCCESS_DURATION_MS.
  successDurationMs = 1785,
  width = LIVING_W_DEFAULT,
  height = LIVING_H_DEFAULT,
}: LivingPlasmaProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const successRef = useRef<{ startAt: number | null; durationMs: number }>({
    startAt: successStartAt ?? null,
    durationMs: successDurationMs,
  });
  successRef.current.startAt = successStartAt ?? null;
  successRef.current.durationMs = successDurationMs;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const PAD_X = 22;
    const PAD_Y = 12;
    const layers = layerSizes.length;
    const layerStep = layers > 1 ? (width - PAD_X * 2) / (layers - 1) : 0;
    const originX = PAD_X + bloomOriginX * (width - PAD_X * 2) - 12;
    const originY = height / 2;

    const sharedBreathY = { v: 0 };
    const SHARED_BREATH_SPEED = 0.00065;

    const nodes: Node[] = [];
    for (let l = 0; l < layers; l++) {
      const count = layerSizes[l];
      const layerX = PAD_X + l * layerStep;
      const layerHeight = (count - 1) * rowSpacing;
      const startY = (height - layerHeight) / 2;
      for (let r = 0; r < count; r++) {
        const baseY = count > 1 ? startY + r * rowSpacing : height / 2;
        const layerCenterRow = (count - 1) / 2;
        const transverseDir = layerCenterRow > 0 ? (r - layerCenterRow) / layerCenterRow : 0;
        nodes.push({
          baseX: layerX,
          baseY,
          layer: l,
          rowInLayer: r,
          spreadY: transverseDir,
          expansionT: 0,
          activation: 0,
          cursorOffsetX: 0,
          cursorOffsetY: 0,
          lockStartAt: null,
          lockProgress: 0,
          lockInitialActivation: 0,
          lockInitialOffsetX: 0,
          lockInitialOffsetY: 0,
        });
      }
    }

    const nodesByLayer: number[][] = Array.from({ length: layers }, () => []);
    for (let i = 0; i < nodes.length; i++) nodesByLayer[nodes[i].layer].push(i);

    const paths: Path[] = [];
    for (let p = 0; p < pathCount; p++) {
      const nodeIdxs: number[] = [];
      const startCandidates = nodesByLayer[0];
      let prevIdx = startCandidates[Math.floor(Math.random() * startCandidates.length)];
      nodeIdxs.push(prevIdx);
      for (let l = 1; l < layers; l++) {
        const candidates = nodesByLayer[l];
        const prev = nodes[prevIdx];
        const sorted = candidates.slice().sort((a, b) => Math.abs(nodes[a].baseY - prev.baseY) - Math.abs(nodes[b].baseY - prev.baseY));
        const topK = sorted.slice(0, Math.min(2, sorted.length));
        const pick = topK[Math.floor(Math.random() * topK.length)];
        nodeIdxs.push(pick);
        prevIdx = pick;
      }
      paths.push({ nodeIdxs, hue: PATH_HUES[p % PATH_HUES.length] });
    }

    const currentPos = (n: Node, breathScale: number, expansionScale: number) => {
      // Locked mode: rendered position is purely a linear interpolation
      // of the offset captured at lock-start toward zero. Breath +
      // expansion + cursor are explicitly ignored so the path is a
      // guaranteed monotonic decay from wherever the node was → home.
      if (n.lockStartAt != null) {
        const inv = 1 - n.lockProgress;
        return {
          x: n.baseX + n.lockInitialOffsetX * inv,
          y: n.baseY + n.lockInitialOffsetY * inv,
        };
      }
      // Free mode: full dynamic position with breath, expansion, cursor.
      const by = Math.sin(sharedBreathY.v) * breathingAmplitude * breathScale;
      const eased = n.expansionT < 0.5
        ? 2 * n.expansionT * n.expansionT
        : 1 - Math.pow(-2 * n.expansionT + 2, 2) / 2;
      const expanded = eased * expansionAmplitude * expansionScale * rowSpacing * 2;
      return {
        x: n.baseX + n.cursorOffsetX,
        y: n.baseY + by + n.spreadY * expanded + n.cursorOffsetY,
      };
    };

    const positionAlongPath = (path: Path, t: number, breathScale: number, expansionScale: number) => {
      const n = path.nodeIdxs.length;
      const seg = Math.max(0, Math.min(n - 1.0001, t * (n - 1)));
      const i = Math.floor(seg);
      const localT = seg - i;
      const p1 = currentPos(nodes[path.nodeIdxs[i]], breathScale, expansionScale);
      const p2 = currentPos(nodes[path.nodeIdxs[i + 1]], breathScale, expansionScale);
      const e = smoothstep(localT);
      return {
        x: p1.x + (p2.x - p1.x) * e,
        y: p1.y + (p2.y - p1.y) * e,
      };
    };

    const pulses: Pulse[] = [];
    const waves: Wave[] = [];
    const cursorRipples: CursorRipple[] = [];
    const cursorTrail: CursorTrailPoint[] = [];

    let frame = 0;
    let lastT = performance.now();
    let lastBurstAt = -Infinity;
    let energy = active ? 1 : 0;
    let cursorX = -10000;
    let cursorY = -10000;
    let prevCursorX = -10000;
    let prevCursorY = -10000;
    let cursorMoveAcc = 0;

    const WAVE_SIGMA = 26;
    const ATTRACTOR_RADIUS = 70;

    const layerDistFromOrigin = (layer: number): number => {
      const layerX = PAD_X + layer * layerStep;
      return Math.abs(layerX - originX);
    };

    const waveContribAtLayer = (now: number, layer: number): { v: number; hueShift: number } => {
      const layerDist = layerDistFromOrigin(layer);
      let bestV = 0;
      let bestHue = 0;
      for (const w of waves) {
        const age = now - w.startAt;
        if (age < 0) continue;
        const r = (age / 1000) * w.speed;
        const d = Math.abs(layerDist - r);
        const v = w.intensity * Math.exp(-(d * d) / (2 * WAVE_SIGMA * WAVE_SIGMA));
        if (v > bestV) {
          bestV = v;
          bestHue = w.hueShift;
        }
      }
      return { v: bestV, hueShift: bestHue };
    };

    const spawnBurst = (now: number) => {
      // Once the success sweep starts, stop generating new pulses/rings —
      // existing ones get absorbed by the green front as it catches them.
      if (successRef.current.startAt != null) return;
      const isActiveNow = activeRef.current;
      const target = isActiveNow ? 1 : 0;
      const pulsesPerBurst = isActiveNow ? pulsesPerBurstActive : pulsesPerBurstIdle;
      const indices = Array.from({ length: paths.length }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const intensity = isActiveNow ? 1 : 0.55;
      const travelMs = isActiveNow ? pathTravelMsActive : pathTravelMsIdle;
      for (let k = 0; k < pulsesPerBurst; k++) {
        const pIdx = indices[k % indices.length];
        pulses.push({
          pathIdx: pIdx,
          startAt: now + k * pulseStaggerMs,
          travelMs,
          intensity: intensity * (0.92 + Math.random() * 0.08),
          hue: paths[pIdx].hue,
        });
      }

      const baseSpeed = isActiveNow ? waveSpeedActive : waveSpeedIdle;
      const waveIntensity = 0.4 + 0.55 * target;
      const rings = isActiveNow ? ringCountActive : ringCountIdle;
      for (let r = 0; r < rings; r++) {
        const ratio = rings > 1 ? (RING_SPEED_RATIOS[r % RING_SPEED_RATIOS.length] ?? 1) : 1;
        waves.push({
          startAt: now + r * 70,
          speed: baseSpeed * ratio,
          hueShift: (Math.random() - 0.5) * 24,
          intensity: waveIntensity,
          firedLayers: new Set<number>(),
        });
      }
    };

    const drawPathGuide = (path: Path, breathScale: number, expansionScale: number, alpha: number) => {
      ctx.strokeStyle = `hsla(${path.hue}, 60%, 56%, ${alpha})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const SAMPLES = 80;
      for (let s = 0; s <= SAMPLES; s++) {
        const pt = positionAlongPath(path, s / SAMPLES, breathScale, expansionScale);
        if (s === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    };

    const applyAttractor = (now: number, dt: number) => {
      // Once success begins the network settles into its final state;
      // the magnetic pull stops grabbing new nodes and existing offsets
      // decay home so the final all-green frame is unwarped.
      const successActive = successRef.current.startAt != null;
      if (successActive || attractor === "off" || cursorX < -1000) {
        for (const n of nodes) {
          n.cursorOffsetX *= 0.86;
          n.cursorOffsetY *= 0.86;
          if (Math.abs(n.cursorOffsetX) < 0.04) n.cursorOffsetX = 0;
          if (Math.abs(n.cursorOffsetY) < 0.04) n.cursorOffsetY = 0;
        }
        return;
      }

      if (attractor === "highlight") {
        for (const n of nodes) {
          const dx = n.baseX - cursorX;
          const dy = n.baseY - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const proximity = Math.max(0, 1 - dist / ATTRACTOR_RADIUS);
          if (proximity > 0) {
            n.activation = Math.max(n.activation, proximity * 0.9);
          }
          n.cursorOffsetX *= 0.88;
          n.cursorOffsetY *= 0.88;
        }
      } else if (attractor === "magnetic") {
        for (const n of nodes) {
          const dx = cursorX - n.baseX;
          const dy = cursorY - n.baseY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const proximity = Math.max(0, 1 - dist / magneticPullRadius);
          const targetX = (dx / dist) * proximity * magneticPullStrength;
          const targetY = (dy / dist) * proximity * magneticPullStrength;
          n.cursorOffsetX += (targetX - n.cursorOffsetX) * 0.14;
          n.cursorOffsetY += (targetY - n.cursorOffsetY) * 0.14;
        }
      } else if (attractor === "ripple") {
        cursorMoveAcc += Math.hypot(cursorX - prevCursorX, cursorY - prevCursorY);
        if (cursorMoveAcc > 22 && prevCursorX > -1000) {
          cursorRipples.push({ x: cursorX, y: cursorY, startAt: now });
          cursorMoveAcc = 0;
        }
        for (const r of cursorRipples) {
          const age = (now - r.startAt) / 1000;
          const radius = age * 70;
          for (const n of nodes) {
            const dx = n.baseX - r.x;
            const dy = n.baseY - r.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const dRing = Math.abs(d - radius);
            const v = Math.exp(-(dRing * dRing) / (2 * 14 * 14)) * Math.max(0, 1 - age / 1.2);
            if (v > 0.08) n.activation = Math.max(n.activation, v * 0.85);
          }
        }
        for (let i = cursorRipples.length - 1; i >= 0; i--) {
          if (now - cursorRipples[i].startAt > 1300) cursorRipples.splice(i, 1);
        }
        for (const n of nodes) {
          n.cursorOffsetX *= 0.88;
          n.cursorOffsetY *= 0.88;
        }
      } else if (attractor === "comet") {
        if (prevCursorX > -1000 && (cursorX !== prevCursorX || cursorY !== prevCursorY)) {
          cursorTrail.unshift({ x: cursorX, y: cursorY, at: now });
        }
        while (cursorTrail.length > 60) cursorTrail.pop();
        // Brighten nodes near the cursor head
        for (const n of nodes) {
          const dx = n.baseX - cursorX;
          const dy = n.baseY - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const proximity = Math.max(0, 1 - dist / 40);
          if (proximity > 0) n.activation = Math.max(n.activation, proximity * 0.85);
          n.cursorOffsetX *= 0.88;
          n.cursorOffsetY *= 0.88;
        }
      } else if (attractor === "warp") {
        // Bloom origin shifts toward cursor proportionally. Recompute
        // spreadY for each node based on shifted origin every frame is
        // costly; instead we just tilt the wave activation by adjusting
        // node activations near the cursor toward higher values.
        for (const n of nodes) {
          const dx = n.baseX - cursorX;
          const dy = n.baseY - cursorY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const proximity = Math.max(0, 1 - dist / (ATTRACTOR_RADIUS + 20));
          if (proximity > 0) n.activation = Math.max(n.activation, proximity * 0.6);
          n.cursorOffsetX *= 0.88;
          n.cursorOffsetY *= 0.88;
        }
      }

      prevCursorX = cursorX;
      prevCursorY = cursorY;
    };

    const drawAttractor = (now: number) => {
      if (attractor === "off" || cursorX < -1000) return;
      if (attractor === "highlight") {
        const sorted = nodes
          .map((n, i) => ({ i, d: Math.hypot(n.baseX - cursorX, n.baseY - cursorY) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        for (const { i, d } of sorted) {
          if (d > ATTRACTOR_RADIUS * 1.5) continue;
          const alpha = Math.max(0, 0.32 * (1 - d / (ATTRACTOR_RADIUS * 1.5)));
          ctx.strokeStyle = `hsla(${LAYER_HUES[nodes[i].layer % LAYER_HUES.length]}, 80%, 70%, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(cursorX, cursorY);
          ctx.lineTo(nodes[i].baseX, nodes[i].baseY);
          ctx.stroke();
        }
      }
      if (attractor === "ripple") {
        for (const r of cursorRipples) {
          const age = (now - r.startAt) / 1000;
          const radius = age * 70;
          const alpha = Math.max(0, 0.4 * (1 - age / 1.2));
          ctx.strokeStyle = `hsla(280, 80%, 70%, ${alpha})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(r.x, r.y, Math.max(0.5, radius), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (attractor === "comet") {
        if (cursorTrail.length > 1) {
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          for (let i = cursorTrail.length - 1; i >= 0; i--) {
            const pt = cursorTrail[i];
            if (i === cursorTrail.length - 1) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          }
          const head = cursorTrail[0];
          const tail = cursorTrail[cursorTrail.length - 1];
          const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
          grad.addColorStop(0, "hsla(280, 80%, 65%, 0)");
          grad.addColorStop(1, "hsla(280, 90%, 78%, 0.85)");
          ctx.strokeStyle = grad;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    };

    const draw = (now: number) => {
      const dt = Math.max(0, Math.min(33, now - lastT));
      lastT = now;

      const targetEnergy = activeRef.current ? 1 : 0;
      energy += (targetEnergy - energy) * 0.05;

      sharedBreathY.v += SHARED_BREATH_SPEED * dt;
      const burstInterval = BURST_INTERVAL_IDLE - (BURST_INTERVAL_IDLE - BURST_INTERVAL_ACTIVE) * energy;
      const breathScale = breathingIdleScale + (1 - breathingIdleScale) * energy;
      const expansionScale = expansionIdleScale + (1 - expansionIdleScale) * energy;

      ctx.clearRect(0, 0, width, height);

      if (now - lastBurstAt > burstInterval) {
        spawnBurst(now);
        lastBurstAt = now;
      }

      // Wave-driven activation + expansion: smooth gaussian based on
      // current wavefront proximity. No discrete fireLayer snap.
      const successFrontPreview = successRef.current.startAt != null
        ? -20 + Math.min(1, (now - successRef.current.startAt) / successRef.current.durationMs) * (width + 40)
        : -1;
      const LOCK_DELAY_MS = 110;
      const LOCK_RAMP_MS = 1090;
      for (const n of nodes) {
        const decayed = n.activation * ACTIVATION_DECAY;
        const wave = waveContribAtLayer(now, n.layer);
        n.activation = Math.max(decayed, wave.v);
        n.expansionT = wave.v;

        // Per-node smooth lock-in. The wavefront visibly passes the
        // node; 160ms later the node begins a 1600ms slow sink toward
        // its home — a properly luxurious "settle into shape" beat.
        // Smoothstep easing (gentle start AND gentle end) prevents any
        // perceptible kick at the lock boundaries.
        if (successFrontPreview >= 0) {
          if (n.lockStartAt == null && n.baseX <= successFrontPreview) {
            // SNAPSHOT pre-lock: capture the live position AND the
            // activation right before we mark the node locked. From
            // here on currentPos uses the locked branch and renders
            // purely against these fixed snapshots.
            const livePos = currentPos(n, breathScale, expansionScale);
            n.lockInitialOffsetX = livePos.x - n.baseX;
            n.lockInitialOffsetY = livePos.y - n.baseY;
            n.lockInitialActivation = n.activation;
            n.lockStartAt = now;
          }
          if (n.lockStartAt != null) {
            const elapsed = now - n.lockStartAt;
            if (elapsed < LOCK_DELAY_MS) {
              n.lockProgress = 0;
            } else {
              const raw = Math.min(1, (elapsed - LOCK_DELAY_MS) / LOCK_RAMP_MS);
              n.lockProgress = raw * raw * (3 - 2 * raw);
            }
          }
        } else if (n.lockStartAt != null) {
          n.lockStartAt = null;
          n.lockProgress = 0;
          n.lockInitialActivation = 0;
          n.lockInitialOffsetX = 0;
          n.lockInitialOffsetY = 0;
        }
      }

      applyAttractor(now, dt);

      // Compute the success wavefront x-position up front so the wave +
      // pulse loops can use it to cull anything it's overtaken.
      const successStart = successRef.current.startAt;
      let successFrontEarly = -1;
      if (successStart != null) {
        const successElapsedT = Math.min(1, (now - successStart) / successRef.current.durationMs);
        successFrontEarly = -20 + successElapsedT * (width + 40);
      }

      ctx.lineCap = "round";

      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const isActive = pulses.some((p) => p.pathIdx === i && now - p.startAt > -50 && now - p.startAt < p.travelMs);
        drawPathGuide(path, breathScale, expansionScale, isActive ? 0.14 : 0.06);
      }

      for (let i = waves.length - 1; i >= 0; i--) {
        const w = waves[i];
        const age = now - w.startAt;
        if (age < 0) continue;
        const r = (age / 1000) * w.speed;
        if (r > width + 80) {
          waves.splice(i, 1);
          continue;
        }
        // Absorbed by the green front: when the rightmost edge of this
        // ring (originX + r) has been overtaken, the ring is gone.
        if (successFrontEarly >= 0 && originX + r < successFrontEarly - 1) {
          waves.splice(i, 1);
          continue;
        }
        const baseHue = 252 + w.hueShift;
        const rDraw = Math.max(0.5, r);
        ctx.strokeStyle = `hsla(${baseHue}, 88%, 72%, ${0.42 * w.intensity})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(originX, originY, rDraw, rDraw * 0.78, 0, -Math.PI / 2.1, Math.PI / 2.1);
        ctx.stroke();
        ctx.strokeStyle = `hsla(${baseHue}, 88%, 72%, ${0.14 * w.intensity})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(originX, originY, rDraw, rDraw * 0.78, 0, -Math.PI / 2.1, Math.PI / 2.1);
        ctx.stroke();
      }

      // Trail rendering: draw each pulse's trail as a single connected
      // polyline with a linear gradient from transparent (tail) to bright
      // (head). Eliminates the dot aliasing of per-segment fading dots,
      // and the trail moves smoothly with the path even as nodes breathe.
      const TRAIL_SAMPLES = 48;
      const TRAIL_WINDOW_T = 0.32;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const age = now - p.startAt;
        if (age < 0) continue;
        const progress = age / p.travelMs;
        if (progress >= 1) {
          const path = paths[p.pathIdx];
          const lastIdx = path.nodeIdxs[path.nodeIdxs.length - 1];
          if (lastIdx != null) nodes[lastIdx].activation = Math.max(nodes[lastIdx].activation, p.intensity * 0.85);
          pulses.splice(i, 1);
          continue;
        }
        const path = paths[p.pathIdx];
        const head = positionAlongPath(path, progress, breathScale, expansionScale);
        // Absorbed: green front has overtaken this pulse's head.
        if (successFrontEarly >= 0 && head.x < successFrontEarly - 2) {
          pulses.splice(i, 1);
          continue;
        }

        const tailT = Math.max(0, progress - TRAIL_WINDOW_T);
        const tail = positionAlongPath(path, tailT, breathScale, expansionScale);

        // Build trail polyline from tail to head
        ctx.beginPath();
        for (let s = 0; s <= TRAIL_SAMPLES; s++) {
          const sampleT = tailT + (progress - tailT) * (s / TRAIL_SAMPLES);
          const pt = positionAlongPath(path, sampleT, breathScale, expansionScale);
          if (s === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }

        // Outer "glow" pass: wider, softer
        const glowGrad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        glowGrad.addColorStop(0, `hsla(${p.hue}, 78%, 64%, 0)`);
        glowGrad.addColorStop(0.5, `hsla(${p.hue}, 78%, 64%, ${0.08 * p.intensity})`);
        glowGrad.addColorStop(1, `hsla(${p.hue}, 80%, 68%, ${0.28 * p.intensity})`);
        ctx.strokeStyle = glowGrad;
        ctx.lineWidth = 4.5;
        ctx.stroke();

        // Core stroke: thinner, brighter — same polyline, second pass
        const coreGrad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
        coreGrad.addColorStop(0, `hsla(${p.hue}, 78%, 64%, 0)`);
        coreGrad.addColorStop(0.55, `hsla(${p.hue}, 80%, 70%, ${0.45 * p.intensity})`);
        coreGrad.addColorStop(1, `hsla(${p.hue}, 88%, 78%, ${0.95 * p.intensity})`);
        ctx.strokeStyle = coreGrad;
        ctx.lineWidth = 1.6;
        ctx.stroke();

        // Bright head halo + white core for emphasis
        ctx.fillStyle = `hsla(${p.hue}, 84%, 74%, ${0.42 * p.intensity})`;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 4.6 * p.intensity, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.95 * p.intensity})`;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 1.4, 0, Math.PI * 2);
        ctx.fill();

        const npLayers = path.nodeIdxs.length;
        const layerIdx = Math.min(npLayers - 1, Math.floor(progress * (npLayers - 1)));
        const localT = progress * (npLayers - 1) - layerIdx;
        if (localT > 0.82) {
          const nIdx = path.nodeIdxs[Math.min(npLayers - 1, layerIdx + 1)];
          if (nIdx != null) nodes[nIdx].activation = Math.max(nodes[nIdx].activation, p.intensity * 0.65);
        }
      }

      // Success wavefront sweep: green wave at `successFrontEarly`
      // (computed at the top of this draw call). Nodes left of it lock
      // bright green; the pulse + ring loops above already cull anything
      // it has overtaken.
      const successFront = successFrontEarly;
      const SUCCESS_HUE = 142;
      const SUCCESS_TARGET_ACTIVATION = 0.94;

      for (const n of nodes) {
        // Smoothly blend hue + activation toward the green-locked end
        // state as lockProgress eases 0 → 1. Hue interpolation is linear
        // (purple 270 → green 142 sweeps through blue/cyan, all cool).
        const baseHue = LAYER_HUES[n.layer % LAYER_HUES.length];
        const hue = baseHue + (SUCCESS_HUE - baseHue) * n.lockProgress;
        // Activation lerps from the value captured at lock-start to the
        // success target, with `max(currentActivation, lerped)` so any
        // late-arriving wave bump can still brighten the node. The
        // fixed source endpoint (not the live, decaying n.activation)
        // is what removes the per-frame jiggle that read as snapping.
        const lockedRamp =
          n.lockStartAt != null
            ? n.lockInitialActivation +
              (SUCCESS_TARGET_ACTIVATION - n.lockInitialActivation) * n.lockProgress
            : 0;
        const renderActivation = Math.max(n.activation, lockedRamp);
        const pos = currentPos(n, breathScale, expansionScale);
        if (renderActivation > 0.05) {
          ctx.fillStyle = `hsla(${hue}, 82%, 60%, ${renderActivation * 0.34})`;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 3 + renderActivation * 7, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `hsla(${hue}, ${68 + renderActivation * 22}%, ${44 + renderActivation * 32}%, ${0.5 + renderActivation * 0.5})`;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 1.4 + renderActivation * 1.5, 0, Math.PI * 2);
        ctx.fill();
        if (renderActivation > 0.62) {
          ctx.fillStyle = `rgba(255,255,255,${(renderActivation - 0.62) * 1.7})`;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 0.85, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw the green wavefront itself if it's currently crossing the
      // canvas. A wide, soft gradient halo with a faint leading line so
      // the wave reads as an atmospheric front rather than a hard edge.
      if (successFront >= 0 && successFront <= width) {
        const grad = ctx.createLinearGradient(successFront - 48, 0, successFront + 10, 0);
        grad.addColorStop(0, `hsla(${SUCCESS_HUE}, 80%, 60%, 0)`);
        grad.addColorStop(0.55, `hsla(${SUCCESS_HUE}, 82%, 62%, 0.10)`);
        grad.addColorStop(0.88, `hsla(${SUCCESS_HUE}, 88%, 70%, 0.28)`);
        grad.addColorStop(1, `hsla(${SUCCESS_HUE}, 92%, 75%, 0.38)`);
        ctx.fillStyle = grad;
        ctx.fillRect(successFront - 48, 0, 58, height);

        ctx.strokeStyle = `hsla(${SUCCESS_HUE}, 94%, 80%, 0.45)`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(successFront, 0);
        ctx.lineTo(successFront, height);
        ctx.stroke();
      }

      drawAttractor(now);

      if (!reduced) frame = requestAnimationFrame(draw);
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursorX = e.clientX - rect.left;
      cursorY = e.clientY - rect.top;
    };
    const onLeave = () => {
      cursorX = -10000;
      cursorY = -10000;
      cursorTrail.length = 0;
    };
    // Touch parity: a finger on the canvas drives the attractor exactly
    // like a mouse cursor. touch-action: none on the canvas style stops
    // the page from scrolling under the finger so this actually works.
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      cursorX = t.clientX - rect.left;
      cursorY = t.clientY - rect.top;
    };
    const onTouchEnd = () => {
      cursorX = -10000;
      cursorY = -10000;
      cursorTrail.length = 0;
    };
    if (attractor !== "off" && !reduced) {
      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseleave", onLeave);
      canvas.addEventListener("touchmove", onTouchMove, { passive: true });
      canvas.addEventListener("touchend", onTouchEnd);
      canvas.addEventListener("touchcancel", onTouchEnd);
    }

    if (reduced) {
      for (const n of nodes) n.activation = 0.4;
      draw(performance.now());
    } else {
      frame = requestAnimationFrame(draw);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [layerSizes, attractor, magneticPullRadius, magneticPullStrength, pathCount, pulsesPerBurstActive, pulsesPerBurstIdle, pulseStaggerMs, trailLength, ringCountActive, ringCountIdle, pathTravelMsActive, pathTravelMsIdle, waveSpeedActive, waveSpeedIdle, bloomOriginX, breathingAmplitude, breathingIdleScale, expansionAmplitude, expansionIdleScale, rowSpacing, width, height]);
  // Note: successStartAt / successDurationMs are intentionally NOT in
  // the deps — they're read via a ref each frame so flipping them
  // doesn't tear down the animation.

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ display: "block", touchAction: "none" }}
    />
  );
}
