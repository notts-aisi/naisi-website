"use client";

import { useEffect, useRef } from "react";
import styles from "./HeroField.module.css";
import {
  PALETTES, sample, exclusionFactor, rgba, easeOutCubic, easeOutQuint,
  Z_SIZE, Z_ALPHA, Z_PARALLAX, pickZBand,
  NODE_BASE_BRIGHTNESS, EDGE_TRAIL_DECAY_PER_S_DEFAULT,
  RGB,
} from "./heroFieldUtils";

/*
  Shared core for the inference-network family. Behaviours wired in
  centrally:
    - Multiple intro modes (no springy crystallisation unless requested).
    - Per-comet palette picked from a configurable pool, forks inherit.
    - Persistent edge trails.
    - Cursor fires inference from nearest node on a cooldown.
    - Optional single-round mode: only fire the next burst when ALL
      live comets have finished AND their trails have visibly faded,
      so the canvas never carries two simultaneous rounds.
    - Optional node coalesce ripple: each particle plays a one-shot
      ring-expand the moment it locks in at its NN home.
    - Optional firefly atmosphere layer: small rising motes in a few
      hues drifting upward independent of the network, for ambient
      depth.
    - Optional breathing scale on the whole network.
*/

export type IntroMode = "stagger" | "fadeIn" | "growFromZero" | "dropIn" | "bigBang" | "noIntro" | "orbitDecay" | "implode" | "bigBangTwin";

export type StaggerNode = { x: number; y: number; layer: number; zBand: 0 | 1 | 2 };

export type FirefliesConfig = {
  count: number;
  palette?: RGB[];
  speedMul?: number;
};

export type StaggerConfig = {
  staggerFn: (node: StaggerNode, ctx: { width: number; height: number; layerCount: number }) => number;
  introMode?: IntroMode;
  particleCrystalDuration?: number;
  particleDissolveDuration?: number;
  crystalEase?: (t: number) => number;
  dissolveEase?: (t: number) => number;
  edgeTrailDecayPerS?: number;
  phaseDriftMs?: number;
  phaseCrystalMs?: number;
  phaseStructuredMs?: number;
  phaseDissolveMs?: number;
  burstIntervalMs?: number;
  streamCount?: number;
  forkProbability?: number;
  continuousOrbit?: boolean;
  alwaysAssembled?: boolean;
  palettePool?: RGB[][];
  breathing?: boolean;
  cursorTrail?: boolean;
  /** When true, only fire the next burst after all comets are done AND trails have faded. */
  singleRoundMode?: boolean;
  /** Extra ms to wait after the last comet completes before the next burst (single-round). */
  roundGapMs?: number;
  /** Play a one-shot ring-expand on each particle the moment it coalesces at NN. */
  nodeCoalesce?: boolean;
  /** Render a layer of rising fireflies for ambient atmosphere. */
  fireflies?: FirefliesConfig;
  /** Multiplies comet travel duration. >1 slower, <1 faster. Default 1. */
  cometDurationMul?: number;
  /** Scales coalesce ring max radius + lifetime. >1 bigger/longer. Default 1. */
  coalesceRingScale?: number;
  /** After the intro phase, wait this long before inference can fire. Default 0. */
  coalescePauseMs?: number;
  /** End of structured phase: stop firing new bursts this many ms before dissolve, so in-flight comets + trails complete cleanly. Default 0. */
  inferenceTailMs?: number;
  /** When set, fire exactly this many rounds per cycle, then stop until dissolve. Requires singleRoundMode. */
  roundsPerCycle?: number;
  /** Each node wobbles around its NN home with its own random Lissajous frequencies + phases. Independent per-node drift, supersedes continuousOrbit. */
  randomWobble?: boolean;
  /** Scales wobble amplitude (default 1 = 3-7px range). */
  wobbleAmpMul?: number;
  /** When < 1, each comet spawns with a random intensity in [cometIntensityMin, 1]. Default 1 (no variation). */
  cometIntensityMin?: number;
  /** When true, layer count scales to 5 or 6 on wider desktop displays. Default false (always 4). */
  responsiveLayers?: boolean;
  /**
   * Subtle gravitational pull of nodes toward the cursor. 0 = none (default),
   * ~0.25 = gentle, ~0.5 = noticeable, ~1.0 = strong. Offset is relative to
   * each node's NN home position so the deformation is stable around home.
   */
  cursorAttractStrength?: number;
};

const DEFAULT_LAYER_COUNT = 4;
const LAYER_FRACTIONS_BY_COUNT: Record<number, number[]> = {
  4: [0.15, 0.40, 0.65, 0.88],
  5: [0.13, 0.32, 0.50, 0.69, 0.88],
  6: [0.12, 0.27, 0.43, 0.59, 0.75, 0.90],
};
const PORTIONS_BY_COUNT: Record<number, number[]> = {
  4: [0.30, 0.32, 0.24, 0.14],
  5: [0.26, 0.24, 0.22, 0.16, 0.12],
  6: [0.22, 0.22, 0.20, 0.16, 0.12, 0.08],
};
const DENSITY_PX2 = 22000;
const COUNT_MIN = 26;
const COUNT_MAX = 60;
const EDGES_PER_NODE = 2;

const COMET_TRAVEL_MS_PER_LAYER = 1100;
const BEZIER_SAG = 0.18;

const FLOW_SCALE_X = 0.0058;
const FLOW_SCALE_Y = 0.0050;
const FLOW_TIME = 0.16;
const FLOW_STRENGTH = 7;

const LENS_RADIUS = 220;
const LENS_FIRE_DIST = 70;
const LENS_FIRE_COOLDOWN_MS = 380;
const NODE_ACTIVATION_DECAY = 0.94;
const BRIGHTNESS_DECAY = 0.965;

const ORBIT_PERIOD_S = 6.0;
const ORBIT_AMPLITUDE_PX = 5;

const BREATHE_PERIOD_S = 7.0;
const BREATHE_AMPLITUDE = 0.03;

const CURSOR_TRAIL_SAMPLES = 24;
const CURSOR_TRAIL_RECORD_MS = 35;

const COALESCE_RIPPLE_MS = 700;
const COALESCE_RIPPLE_THRESHOLD = 0.92;

const FIREFLY_LIFETIME_MIN_MS = 6000;
const FIREFLY_LIFETIME_MAX_MS = 11000;
const FIREFLY_SPEED_MIN = 8;
const FIREFLY_SPEED_MAX = 22;

const DEFAULT_POOL = [PALETTES.VIRIDIS, PALETTES.PLASMA, PALETTES.INFERNO, PALETTES.MAGMA, PALETTES.CIVIDIS];
const DEFAULT_FIREFLY_PALETTE = [PALETTES.NAISI_COLD, PALETTES.NAISI_PINK];

type Node = {
  x: number; y: number; vx: number; vy: number;
  introStartX: number; introStartY: number;
  driftHomeX: number; driftHomeY: number;
  nnX: number; nnY: number;
  layer: number; zBand: 0 | 1 | 2;
  paletteIdx: number; hueT: number;
  activation: number; brightness: number; phase: number; phase2: number;
  outEdges: number[];
  crystalT0: number;
  dissolveT0: number;
  /** Time when this particle first crossed the coalesce threshold (-1 = not yet). */
  coalescedAt: number;
  /** Random Lissajous wobble parameters — unique per node so each drifts independently. */
  wobbleFreqXa: number; wobbleFreqXb: number;
  wobbleFreqYa: number; wobbleFreqYb: number;
  wobblePhaseXa: number; wobblePhaseXb: number;
  wobblePhaseYa: number; wobblePhaseYb: number;
  wobbleAmpX: number; wobbleAmpY: number;
};
type Edge = {
  from: number; to: number;
  cx: number; cy: number; length: number;
  lit: number;
  paletteIdx: number; hueT: number;
};
type Comet = { edgeIdx: number; t: number; duration: number; hue: number; paletteIdx: number; intensity: number };
type ArrivalEcho = { x: number; y: number; bornAt: number; hue: number; paletteIdx: number };
type Firefly = {
  x: number; y: number; vx: number; vy: number;
  paletteIdx: number; hueT: number;
  size: number; phase: number;
  bornAt: number; lifetime: number;
};

export default function HeroFieldStaggerCore(config: StaggerConfig) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarse = window.matchMedia("(pointer: coarse)").matches;

    const introMode: IntroMode = config.introMode ?? "stagger";
    const PARTICLE_CRYSTAL_DURATION = config.particleCrystalDuration ?? 1800;
    const PARTICLE_DISSOLVE_DURATION = config.particleDissolveDuration ?? 1600;
    const crystalEase = config.crystalEase ?? easeOutCubic;
    const dissolveEase = config.dissolveEase ?? easeOutCubic;
    const EDGE_TRAIL_DECAY_PER_S = config.edgeTrailDecayPerS ?? EDGE_TRAIL_DECAY_PER_S_DEFAULT;
    const useDriftPhase = introMode === "stagger" || introMode === "orbitDecay";
    const PHASE_DRIFT_MS = (config.phaseDriftMs ?? 4000) * (useDriftPhase ? 1 : 0);
    const PHASE_CRYSTAL_MS = config.phaseCrystalMs ?? 4000;
    const PHASE_STRUCTURED_MS = config.phaseStructuredMs ?? 9000;
    const PHASE_DISSOLVE_MS = config.phaseDissolveMs ?? 2400;
    const CYCLE_MS = PHASE_DRIFT_MS + PHASE_CRYSTAL_MS + PHASE_STRUCTURED_MS + PHASE_DISSOLVE_MS;
    const BURST_INTERVAL_MS = config.burstIntervalMs ?? 2200;
    const STREAM_COUNT = Math.max(1, config.streamCount ?? 1);
    const FORK_PROBABILITY = config.forkProbability ?? 0.78;
    const STAGGER_WINDOW_CRYSTAL = Math.max(0, PHASE_CRYSTAL_MS - PARTICLE_CRYSTAL_DURATION);
    const STAGGER_WINDOW_DISSOLVE = Math.max(0, PHASE_DISSOLVE_MS - PARTICLE_DISSOLVE_DURATION);
    const continuousOrbit = !!config.continuousOrbit;
    const alwaysAssembled = !!config.alwaysAssembled;
    const palettePool = config.palettePool ?? DEFAULT_POOL;
    const breathing = !!config.breathing;
    const useCursorTrail = !!config.cursorTrail && !coarse;
    const singleRoundMode = !!config.singleRoundMode;
    const ROUND_GAP_MS = config.roundGapMs ?? 1200;
    const nodeCoalesce = !!config.nodeCoalesce;
    const fireflyCount = config.fireflies?.count ?? 0;
    const fireflyPalette = config.fireflies?.palette ? [config.fireflies.palette] : DEFAULT_FIREFLY_PALETTE;
    const fireflySpeedMul = config.fireflies?.speedMul ?? 1;
    const cometDurationMul = config.cometDurationMul ?? 1;
    const coalesceRingScale = config.coalesceRingScale ?? 1;
    const coalescePauseMs = config.coalescePauseMs ?? 0;
    const inferenceTailMs = config.inferenceTailMs ?? 0;
    const roundsPerCycle = config.roundsPerCycle;
    const randomWobble = !!config.randomWobble;
    const wobbleAmpMul = config.wobbleAmpMul ?? 1;
    const cometIntensityMin = config.cometIntensityMin ?? 1;
    const responsiveLayers = !!config.responsiveLayers;
    const cursorAttractStrength = config.cursorAttractStrength ?? 0;
    const CURSOR_ATTRACT_RADIUS = 260;

    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0, height = 0;
    let nodes: Node[] = [];
    let edges: Edge[] = [];
    let comets: Comet[] = [];
    let arrivalEchoes: ArrivalEcho[] = [];
    let fireflies: Firefly[] = [];
    let scrollY = 0;
    // Layer count and fractions are responsive when configured; otherwise default 4.
    let LAYER_COUNT = DEFAULT_LAYER_COUNT;
    let LAYER_FRACTIONS = LAYER_FRACTIONS_BY_COUNT[DEFAULT_LAYER_COUNT];
    let PORTION = PORTIONS_BY_COUNT[DEFAULT_LAYER_COUNT];
    // Single-round bookkeeping.
    let roundActive = false;
    let lastCometCompletedAt = -Infinity;
    // Per-cycle bookkeeping. Used to detect cycle rollover and to count
    // rounds fired so we can stop after roundsPerCycle.
    let lastCycleMs = 0;
    let cycleRoundsFired = 0;
    // When the LAST particle in the current cycle crosses the coalesce
    // threshold. Anchors the coalesce pause to actual arrival, not
    // arbitrary cycle time. Reset to -1 each cycle.
    let allCoalescedAt = -1;
    // When the most recent burst was FIRED. Rounds are scheduled at
    // lastBurstFiredAt + (estimated round duration + roundGapMs),
    // floored at 100ms. Negative roundGapMs means rounds overlap.
    let lastBurstFiredAt = -Infinity;

    const computeIntroStart = (nnX: number, nnY: number): [number, number] => {
      switch (introMode) {
        case "stagger":
        case "orbitDecay":
          return [Math.random() * width, Math.random() * height];
        case "dropIn":
          return [nnX + (Math.random() - 0.5) * 40, -height * 0.15 - Math.random() * height * 0.2];
        case "bigBang":
          return [width / 2 + (Math.random() - 0.5) * 30, height / 2 + (Math.random() - 0.5) * 30];
        case "bigBangTwin": {
          // Particles in the left half emerge from a left-side centre,
          // particles in the right half from a right-side centre.
          const leftHalf = nnX < width / 2;
          const cx = leftHalf ? width * 0.28 : width * 0.72;
          const cy = height * 0.5;
          return [cx + (Math.random() - 0.5) * 30, cy + (Math.random() - 0.5) * 30];
        }
        case "implode": {
          const edge = Math.floor(Math.random() * 4);
          if (edge === 0) return [Math.random() * width, -50];
          if (edge === 1) return [width + 50, Math.random() * height];
          if (edge === 2) return [Math.random() * width, height + 50];
          return [-50, Math.random() * height];
        }
        case "fadeIn":
        case "growFromZero":
        case "noIntro":
          return [nnX, nnY];
      }
    };

    const initFireflies = (now: number) => {
      fireflies = [];
      for (let i = 0; i < fireflyCount; i++) {
        const pPick = fireflyPalette[Math.floor(Math.random() * fireflyPalette.length)];
        fireflies.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 6,
          vy: -(FIREFLY_SPEED_MIN + Math.random() * (FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN)) * fireflySpeedMul,
          paletteIdx: palettePoolIndex(pPick),
          hueT: 0.55 + Math.random() * 0.4,
          size: 1.5 + Math.random() * 2.5,
          phase: Math.random() * Math.PI * 2,
          bornAt: now - Math.random() * FIREFLY_LIFETIME_MAX_MS,
          lifetime: FIREFLY_LIFETIME_MIN_MS + Math.random() * (FIREFLY_LIFETIME_MAX_MS - FIREFLY_LIFETIME_MIN_MS),
        });
      }
    };

    /** Find the index in palettePool of a given palette, falling back to 0. */
    const palettePoolIndex = (p: RGB[]) => {
      const i = palettePool.indexOf(p);
      return i >= 0 ? i : 0;
    };

    const init = () => {
      const vertical = width < height || width < 600;
      // Compute layer count based on viewport when responsive — wider
      // desktops get a richer 5- or 6-layer network.
      LAYER_COUNT = responsiveLayers && !vertical
        ? (width >= 1400 ? 6 : width >= 1000 ? 5 : 4)
        : DEFAULT_LAYER_COUNT;
      LAYER_FRACTIONS = LAYER_FRACTIONS_BY_COUNT[LAYER_COUNT];
      PORTION = PORTIONS_BY_COUNT[LAYER_COUNT];
      const target = Math.max(COUNT_MIN, Math.min(COUNT_MAX, Math.floor((width * height) / DENSITY_PX2)));
      const portion = PORTION;
      nodes = []; edges = []; comets = []; arrivalEchoes = [];
      roundActive = false;
      lastCometCompletedAt = -Infinity;
      lastCycleMs = 0;
      cycleRoundsFired = 0;
      allCoalescedAt = -1;
      lastBurstFiredAt = -Infinity;
      for (let l = 0; l < LAYER_COUNT; l++) {
        const count = Math.max(3, Math.round(target * portion[l]));
        for (let i = 0; i < count; i++) {
          let nnX: number, nnY: number;
          if (vertical) {
            const pad = width * 0.12; const usable = width - pad * 2;
            const step = count > 1 ? usable / (count - 1) : 0;
            nnX = pad + (count > 1 ? step * i : usable / 2) + (Math.random() - 0.5) * (step * 0.25);
            nnY = LAYER_FRACTIONS[l] * height + (Math.random() - 0.5) * (height / 70);
          } else {
            const pad = height * 0.10; const usable = height - pad * 2;
            const step = count > 1 ? usable / (count - 1) : 0;
            nnX = LAYER_FRACTIONS[l] * width + (Math.random() - 0.5) * (width / 70);
            nnY = pad + (count > 1 ? step * i : usable / 2) + (Math.random() - 0.5) * (step * 0.25);
          }
          const zBand = pickZBand(Math.random());
          const [introStartX, introStartY] = computeIntroStart(nnX, nnY);
          // In reduced-motion mode the core renders exactly one frame
          // and freezes. Without this branch, iPhone Safari under Low
          // Power Mode draws a blank canvas — the single frame is
          // cycleMs ≈ 0 where Big Bang particles haven't flown in yet.
          // Spawn directly at NN home so the static frame shows the
          // assembled network.
          const startX = (alwaysAssembled || reduced) ? nnX : introStartX;
          const startY = (alwaysAssembled || reduced) ? nnY : introStartY;
          const rawDelay = config.staggerFn({ x: nnX, y: nnY, layer: l, zBand }, { width, height, layerCount: LAYER_COUNT });
          const crystalT0 = Math.max(0, Math.min(STAGGER_WINDOW_CRYSTAL, rawDelay));
          const dissolveT0 = STAGGER_WINDOW_DISSOLVE > 0
            ? Math.max(0, Math.min(STAGGER_WINDOW_DISSOLVE, rawDelay * (STAGGER_WINDOW_DISSOLVE / Math.max(1, STAGGER_WINDOW_CRYSTAL))))
            : 0;
          nodes.push({
            x: startX, y: startY,
            vx: 0, vy: 0,
            introStartX, introStartY,
            driftHomeX: Math.random() * width, driftHomeY: Math.random() * height,
            nnX, nnY, layer: l, zBand,
            paletteIdx: 0, hueT: 0.4,
            activation: 0, brightness: 1,
            phase: Math.random() * Math.PI * 2, phase2: Math.random() * Math.PI * 2,
            outEdges: [],
            crystalT0, dissolveT0,
            coalescedAt: (alwaysAssembled || reduced) ? performance.now() - COALESCE_RIPPLE_MS - 1 : -1,
            wobbleFreqXa: 0.18 + Math.random() * 0.32,
            wobbleFreqXb: 0.28 + Math.random() * 0.45,
            wobbleFreqYa: 0.18 + Math.random() * 0.32,
            wobbleFreqYb: 0.28 + Math.random() * 0.45,
            wobblePhaseXa: Math.random() * Math.PI * 2,
            wobblePhaseXb: Math.random() * Math.PI * 2,
            wobblePhaseYa: Math.random() * Math.PI * 2,
            wobblePhaseYb: Math.random() * Math.PI * 2,
            wobbleAmpX: 3 + Math.random() * 4,
            wobbleAmpY: 3 + Math.random() * 4,
          });
        }
      }
      const v = vertical;
      for (let l = 0; l < LAYER_COUNT - 1; l++) {
        const src = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l);
        const dst = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l + 1);
        for (const s of src) {
          const sorted = dst
            .map((d) => ({ idx: d.i, n: d.n, dist: v ? Math.abs(d.n.nnX - s.n.nnX) : Math.abs(d.n.nnY - s.n.nnY) }))
            .sort((a, b) => a.dist - b.dist).slice(0, EDGES_PER_NODE);
          for (const d of sorted) {
            const a = s.n, b = d.n;
            const mx = (a.nnX + b.nnX) / 2, my = (a.nnY + b.nnY) / 2;
            const dx = b.nnX - a.nnX, dy = b.nnY - a.nnY;
            const len = Math.hypot(dx, dy);
            const perpX = -dy / len, perpY = dx / len;
            const sign = ((s.i + d.idx) % 2 === 0) ? 1 : -1;
            const sag = BEZIER_SAG * len * sign;
            const eIdx = edges.length;
            edges.push({
              from: s.i, to: d.idx,
              cx: mx + perpX * sag, cy: my + perpY * sag, length: len,
              lit: 0, paletteIdx: 0, hueT: 0.4,
            });
            s.n.outEdges.push(eIdx);
          }
        }
      }
      if (fireflyCount > 0) initFireflies(performance.now());
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.clientWidth; height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
      // Force reflow — iOS Safari occasionally caches stale layout
      // dimensions after setting canvas.width/height, leaving the canvas
      // visually 0×0 even though the backing store sized correctly.
      void canvas.offsetHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); init();
    };
    resize();
    const ro = new ResizeObserver(() => resize()); ro.observe(canvas);
    // Defensive resize at +100ms in case ResizeObserver doesn't fire
    // quickly enough on iOS Safari and the first resize() captured
    // canvas.clientWidth/Height as 0 (parent layout not finalised yet).
    // No-op when dimensions match.
    const deferredResizeTimer = window.setTimeout(() => {
      if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
        resize();
      }
    }, 100);

    let cursorX = -9999, cursorY = -9999, cursorActive = false;
    let lastCursorFireAt = -Infinity;
    const cursorTrail: { x: number; y: number; bornAt: number }[] = [];
    let lastCursorTrailAt = 0;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursorX = e.clientX - rect.left; cursorY = e.clientY - rect.top; cursorActive = true;
    };
    const onLeave = () => { cursorActive = false; };
    // Listen on the closest [data-hero] ancestor so cursor events bubble
    // up from EVERY child (logo, headline, badge, …) and the attractor
    // doesn't get blocked by overlay content. Falls back to the canvas's
    // direct parent for preview contexts (hero-alts page) where there's
    // no data-hero wrapper.
    const findCursorTarget = (): HTMLElement | null => {
      let cur: HTMLElement | null = canvas.parentElement;
      while (cur) {
        if (cur.dataset && cur.dataset.hero) return cur;
        cur = cur.parentElement;
      }
      return canvas.parentElement;
    };
    const cursorTarget = findCursorTarget();
    if (!coarse && cursorTarget) {
      cursorTarget.addEventListener("mousemove", onMove);
      cursorTarget.addEventListener("mouseleave", onLeave);
    }
    const onScroll = () => { scrollY = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });

    const startT = performance.now();
    let lastT = startT;
    const lastBurstAtPerStream: number[] = [];
    for (let s = 0; s < STREAM_COUNT; s++) {
      lastBurstAtPerStream.push(startT - BURST_INTERVAL_MS + (s * BURST_INTERVAL_MS / STREAM_COUNT));
    }
    let frame = 0, visible = true;

    const flowAt = (x: number, y: number, t: number) => ({
      x: (Math.sin(x * FLOW_SCALE_X + t * FLOW_TIME)
        + Math.cos(y * FLOW_SCALE_Y * 1.3 - t * FLOW_TIME * 0.7)) * FLOW_STRENGTH,
      y: (Math.cos(x * FLOW_SCALE_X * 1.2 - t * FLOW_TIME * 0.8)
        + Math.sin(y * FLOW_SCALE_Y + t * FLOW_TIME * 1.1)) * FLOW_STRENGTH,
    });

    const introAmount = (n: Node, cycleMs: number) => {
      if (alwaysAssembled || reduced) return 1;
      if (cycleMs < PHASE_DRIFT_MS) return 0;
      const inCrystal = cycleMs - PHASE_DRIFT_MS;
      if (inCrystal < PHASE_CRYSTAL_MS) {
        return crystalEase((inCrystal - n.crystalT0) / PARTICLE_CRYSTAL_DURATION);
      }
      const inStructured = inCrystal - PHASE_CRYSTAL_MS;
      if (inStructured < PHASE_STRUCTURED_MS) return 1;
      const inDissolve = inStructured - PHASE_STRUCTURED_MS;
      return 1 - dissolveEase((inDissolve - n.dissolveT0) / PARTICLE_DISSOLVE_DURATION);
    };

    const inStructuredPhase = (cycleMs: number) => {
      if (alwaysAssembled) return true;
      const inStructured = cycleMs - PHASE_DRIFT_MS - PHASE_CRYSTAL_MS;
      return inStructured >= 0 && inStructured < PHASE_STRUCTURED_MS;
    };

    const pickPalette = () => Math.floor(Math.random() * palettePool.length);

    const fireBurst = (originNodeIdx?: number) => {
      const pickIntensity = () => cometIntensityMin + Math.random() * (1 - cometIntensityMin);
      if (originNodeIdx !== undefined) {
        const n = nodes[originNodeIdx];
        if (n.outEdges.length === 0) return;
        const eIdx = n.outEdges[Math.floor(Math.random() * n.outEdges.length)];
        const e = edges[eIdx];
        const duration = COMET_TRAVEL_MS_PER_LAYER * cometDurationMul * (0.6 + e.length / Math.max(width, height) * 1.4);
        const paletteIdx = pickPalette();
        comets.push({ edgeIdx: eIdx, t: 0, duration, hue: 0.55 + Math.random() * 0.4, paletteIdx, intensity: pickIntensity() });
        n.activation = Math.max(n.activation, 1);
        n.paletteIdx = paletteIdx;
        n.hueT = 0.85;
        return;
      }
      const inputs = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === 0);
      for (const input of inputs) {
        for (const eIdx of input.n.outEdges) {
          const e = edges[eIdx];
          const duration = COMET_TRAVEL_MS_PER_LAYER * cometDurationMul * (0.6 + e.length / Math.max(width, height) * 1.4);
          const paletteIdx = pickPalette();
          comets.push({ edgeIdx: eIdx, t: 0, duration, hue: 0.55 + Math.random() * 0.4, paletteIdx, intensity: pickIntensity() });
        }
        input.n.activation = Math.max(input.n.activation, 1);
        input.n.paletteIdx = pickPalette();
        input.n.hueT = 0.85;
      }
      roundActive = true;
    };

    const bezierAt = (e: Edge, t: number) => {
      const a = nodes[e.from], b = nodes[e.to];
      const omt = 1 - t;
      return {
        x: omt * omt * a.x + 2 * omt * t * e.cx + t * t * b.x,
        y: omt * omt * a.y + 2 * omt * t * e.cy + t * t * b.y,
      };
    };

    const maxEdgeLit = () => {
      let m = 0;
      for (const e of edges) if (e.lit > m) m = e.lit;
      return m;
    };

    const draw = (now: number) => {
      const dt = Math.min(0.033, (now - lastT) / 1000);
      lastT = now;
      const t = (now - startT) / 1000;
      const cycleMs = (now - startT) % CYCLE_MS;
      const parallax = scrollY * 0.05;

      // Cycle rollover — when the cycle clock wraps, hard-clear any
      // residual inference state so the next intro/coalesce starts
      // visually clean. No stray comet heads, no lingering edge trails,
      // no half-faded echoes leaking into the next Big Bang.
      if (cycleMs < lastCycleMs) {
        comets.length = 0;
        arrivalEchoes.length = 0;
        for (const e of edges) e.lit = 0;
        for (const n of nodes) n.coalescedAt = -1;
        roundActive = false;
        cycleRoundsFired = 0;
        lastCometCompletedAt = -Infinity;
        allCoalescedAt = -1;
        lastBurstFiredAt = -Infinity;
      }
      // Dissolve-entry cleanup — once we cross into the dissolve phase,
      // hard-clear in-flight comets + arrival echoes so they don't drag
      // behind the dissolving particles. Edge trails get accelerated
      // decay (handled below) so they fade out fully before dissolve
      // ends instead of leaking into the next Big Bang.
      const endOfStructured = PHASE_DRIFT_MS + PHASE_CRYSTAL_MS + PHASE_STRUCTURED_MS;
      const inDissolve = cycleMs > endOfStructured;
      const wasInDissolve = lastCycleMs > endOfStructured;
      if (inDissolve && !wasInDissolve) {
        comets.length = 0;
        arrivalEchoes.length = 0;
      }
      lastCycleMs = cycleMs;

      // Inference-active window — burst-scheduling only fires comets
      // when we're inside the structured phase AND past the coalesce
      // pause AND before the inference tail AND under the per-cycle
      // round cap (if set).
      const intoStructured = cycleMs - PHASE_DRIFT_MS - PHASE_CRYSTAL_MS;
      const structuredOpen = intoStructured >= coalescePauseMs;
      const structuredClosing = intoStructured > PHASE_STRUCTURED_MS - inferenceTailMs;
      const roundCapHit = roundsPerCycle !== undefined && cycleRoundsFired >= roundsPerCycle;
      // Dynamic coalesce gating: only allow inference once the LAST
      // particle has crossed the coalesce threshold AND coalescePauseMs
      // has elapsed since then. Anchors the pause to actual arrival,
      // not arbitrary cycle time — so if layer-staggered entry runs long
      // (6-layer responsive grid + 450ms-per-layer stagger), inference
      // still doesn't fire until everyone has settled and breathed.
      const dynamicCoalesceOk = allCoalescedAt > 0 && now - allCoalescedAt > coalescePauseMs;
      const inferenceCanFire = inStructuredPhase(cycleMs) && structuredOpen && dynamicCoalesceOk && !structuredClosing && !roundCapHit;
      // Cursor-fires are decoupled from the round cap — once both auto
      // rounds have fired, autobursts stop but the user can keep
      // spawning comets with the mouse for the rest of the inference
      // window. Otherwise the mouse appears to "break" partway through.
      const cursorCanFire = inStructuredPhase(cycleMs) && structuredOpen && dynamicCoalesceOk && !structuredClosing;

      if (!reduced && inferenceCanFire) {
        if (singleRoundMode) {
          // Burst-interval scheduling — next round fires at
          // lastBurstFiredAt + (estimated round duration + roundGapMs),
          // floored at 100ms. Negative roundGapMs lets rounds overlap:
          //   gap =  0   → round 2 fires when round 1's last comet
          //                arrives at output (back-to-back).
          //   gap = -5s  → round 2 fires while round 1 is still in
          //                flight, ~5s into the network.
          //   gap = -10s → near-immediate overlap (capped by 100ms floor).
          const estimatedRoundDuration = COMET_TRAVEL_MS_PER_LAYER * cometDurationMul * Math.max(1, LAYER_COUNT - 1);
          const roundIntervalMs = Math.max(100, estimatedRoundDuration + ROUND_GAP_MS);
          if (lastBurstFiredAt === -Infinity || now - lastBurstFiredAt > roundIntervalMs) {
            fireBurst();
            cycleRoundsFired++;
            lastBurstFiredAt = now;
          }
        } else {
          for (let s = 0; s < STREAM_COUNT; s++) {
            if (now - lastBurstAtPerStream[s] > BURST_INTERVAL_MS) {
              fireBurst();
              lastBurstAtPerStream[s] = now;
            }
          }
        }
      }

      // Cursor-driven fire — gated to the active inference window. Outside
      // it (coalesce pause, inference tail, dissolve, intro), the cursor
      // does not fire comets so no stray inference appears mid-Big-Bang.
      if (cursorActive && !coarse && cursorCanFire && now - lastCursorFireAt > LENS_FIRE_COOLDOWN_MS) {
        let bestI = -1, bestD = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].outEdges.length === 0) continue;
          const dx = nodes[i].x - cursorX, dy = nodes[i].y - cursorY;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0 && bestD < LENS_FIRE_DIST * LENS_FIRE_DIST && introAmount(nodes[bestI], cycleMs) > 0.4) {
          fireBurst(bestI);
          lastCursorFireAt = now;
        }
      }

      if (useCursorTrail && cursorActive && now - lastCursorTrailAt > CURSOR_TRAIL_RECORD_MS) {
        cursorTrail.push({ x: cursorX, y: cursorY, bornAt: now });
        if (cursorTrail.length > CURSOR_TRAIL_SAMPLES) cursorTrail.shift();
        lastCursorTrailAt = now;
      }

      // Comet advance + edge lighting + arrival forking + arrival echo.
      const arrived: { edgeIdx: number; hue: number; paletteIdx: number; intensity: number }[] = [];
      for (const c of comets) {
        c.t += (dt * 1000) / c.duration;
        const e = edges[c.edgeIdx];
        const env = Math.sin(Math.min(1, c.t) * Math.PI) * c.intensity;
        if (env > e.lit * 0.9) {
          e.lit = Math.max(e.lit, 0.95 * env);
          e.paletteIdx = c.paletteIdx;
          e.hueT = c.hue;
        }
      }
      for (let i = comets.length - 1; i >= 0; i--) {
        if (comets[i].t >= 1) {
          arrived.push({ edgeIdx: comets[i].edgeIdx, hue: comets[i].hue, paletteIdx: comets[i].paletteIdx, intensity: comets[i].intensity });
          comets.splice(i, 1);
        }
      }
      for (const a of arrived) {
        const e = edges[a.edgeIdx];
        const dest = nodes[e.to];
        dest.activation = Math.min(1, dest.activation + 0.6 * a.intensity);
        dest.hueT = a.hue; dest.paletteIdx = a.paletteIdx;
        // Arrival echo bridges the visual gap between comet vanishing
        // and forks emerging, so the head doesn't appear to stutter.
        arrivalEchoes.push({ x: dest.x, y: dest.y, bornAt: now, hue: a.hue, paletteIdx: a.paletteIdx });
        for (const oIdx of dest.outEdges) {
          if (Math.random() < FORK_PROBABILITY) {
            const oe = edges[oIdx];
            const duration = COMET_TRAVEL_MS_PER_LAYER * cometDurationMul * (0.6 + oe.length / Math.max(width, height) * 1.4);
            comets.push({
              edgeIdx: oIdx, t: 0, duration,
              hue: Math.min(0.98, a.hue + 0.03), paletteIdx: a.paletteIdx,
              intensity: a.intensity * (0.92 + Math.random() * 0.16),
            });
          }
        }
        if (dest.layer === LAYER_COUNT - 1) { dest.activation = 1; dest.brightness = 1.6; }
      }
      // Prune old arrival echoes (~280ms life).
      arrivalEchoes = arrivalEchoes.filter((e) => now - e.bornAt < 280);

      // Edge trail decay — boosted during dissolve so trails are gone
      // before the next Big Bang. With dt~0.016 and boost=4, a fully-lit
      // edge falls to ~0 over ~0.5s.
      const decayMul = inDissolve ? 4 : 1;
      const decayFactor = Math.pow(EDGE_TRAIL_DECAY_PER_S, dt * decayMul);
      for (const e of edges) e.lit *= decayFactor;

      // Attractor envelope — fades in over ~800ms after the last
      // particle coalesces, holds at 1 through the inference window,
      // fades to 0 over the last 800ms before dissolve. So during
      // layer entry / exit the cursor has zero positional effect, no
      // bug-out from mid-coalesce pulls. Only when the network is
      // genuinely settled does the attractor engage.
      let attractorEnv = 0;
      if (allCoalescedAt > 0) {
        attractorEnv = Math.min(1, (now - allCoalescedAt) / 800);
      }
      if (!inDissolve) {
        const msToDissolve = endOfStructured - cycleMs;
        if (msToDissolve > 0 && msToDissolve < 800) {
          attractorEnv = Math.min(attractorEnv, msToDissolve / 800);
        }
      } else {
        attractorEnv = 0;
      }
      const effectiveAttract = cursorAttractStrength * attractorEnv;

      // Position update (per intro mode) + coalesce timestamp recording.
      if (!reduced) {
        let coalescedCount = 0;
        for (const n of nodes) {
          const amt = introAmount(n, cycleMs);
          // Record per-node coalesce timestamp regardless of whether
          // we're rendering rings — we still need it to anchor the
          // global coalesce pause to actual arrival.
          if (n.coalescedAt < 0 && amt >= COALESCE_RIPPLE_THRESHOLD) {
            n.coalescedAt = now;
          }
          if (n.coalescedAt > 0) coalescedCount++;
          // Compute optional offset around NN home from continuous-orbit
          // (synced sine across all nodes) or random-wobble (per-node
          // independent Lissajous of two sines). Random wobble supersedes
          // continuous orbit when both are set.
          let wobX = 0, wobY = 0;
          if (randomWobble) {
            const ampScale = (0.6 + Z_SIZE[n.zBand] * 0.4) * wobbleAmpMul;
            wobX = (Math.sin(t * n.wobbleFreqXa + n.wobblePhaseXa) * 0.6
                  + Math.cos(t * n.wobbleFreqXb + n.wobblePhaseXb) * 0.4) * n.wobbleAmpX * ampScale;
            wobY = (Math.cos(t * n.wobbleFreqYa + n.wobblePhaseYa) * 0.6
                  + Math.sin(t * n.wobbleFreqYb + n.wobblePhaseYb) * 0.4) * n.wobbleAmpY * ampScale;
          } else if (continuousOrbit) {
            const amp = ORBIT_AMPLITUDE_PX * (0.6 + Z_SIZE[n.zBand] * 0.8);
            const omega = (2 * Math.PI) / ORBIT_PERIOD_S;
            wobX = Math.cos(omega * t + n.phase) * amp * 0.9;
            wobY = Math.sin(omega * t * 0.83 + n.phase2) * amp * 0.6;
          }
          // Cursor attractor — node is gently pulled toward cursor when
          // it's inside CURSOR_ATTRACT_RADIUS of the node's NN home.
          // Offset is measured from NN home so the deformation is stable
          // (no positive-feedback drift). Only applied once the node is
          // assembled enough to have a stable home.
          let attrX = 0, attrY = 0;
          if (effectiveAttract > 0 && cursorActive && !coarse && amt > 0.6) {
            const adx = cursorX - n.nnX;
            const ady = cursorY - n.nnY;
            const aDist = Math.sqrt(adx * adx + ady * ady);
            if (aDist < CURSOR_ATTRACT_RADIUS && aDist > 2) {
              const falloff = 1 - aDist / CURSOR_ATTRACT_RADIUS;
              attrX = adx * falloff * effectiveAttract;
              attrY = ady * falloff * effectiveAttract;
            }
          }
          if (introMode === "fadeIn" || introMode === "growFromZero" || introMode === "noIntro") {
            const enableWobble = (continuousOrbit || randomWobble) && amt > 0.6;
            const tx = n.nnX + (enableWobble ? wobX : 0) + attrX;
            const ty = n.nnY + (enableWobble ? wobY : 0) + attrY;
            n.x += (tx - n.x) * 0.18;
            n.y += (ty - n.y) * 0.18;
          } else if (introMode === "dropIn" || introMode === "bigBang" || introMode === "implode" || introMode === "bigBangTwin") {
            let tx = n.introStartX + (n.nnX - n.introStartX) * amt;
            let ty = n.introStartY + (n.nnY - n.introStartY) * amt;
            if ((continuousOrbit || randomWobble) && amt > 0.95) {
              tx += wobX;
              ty += wobY;
            }
            tx += attrX;
            ty += attrY;
            // Lerp toward target instead of hard-assigning so cursor pull
            // springs in smoothly when the cursor enters / leaves range.
            if (amt > 0.95) {
              n.x += (tx - n.x) * 0.20;
              n.y += (ty - n.y) * 0.20;
            } else {
              n.x = tx; n.y = ty;
            }
          } else {
            const flow = flowAt(n.x, n.y, t);
            const speedMul = 0.55 + Z_SIZE[n.zBand] * 0.35;
            n.vx += flow.x * dt * speedMul * (1 - amt);
            n.vy += flow.y * dt * speedMul * (1 - amt);
            if (amt > 0.001) {
              const k = introMode === "orbitDecay" ? 0.03 * amt : 0.05 * amt;
              n.vx += (n.nnX - n.x) * k;
              n.vy += (n.nnY - n.y) * k;
            }
            if ((continuousOrbit || randomWobble) && amt > 0.95) {
              n.vx += ((n.nnX + wobX + attrX) - n.x) * 0.10;
              n.vy += ((n.nnY + wobY + attrY) - n.y) * 0.10;
            } else if (effectiveAttract > 0 && amt > 0.5) {
              n.vx += ((n.nnX + attrX) - n.x) * 0.06;
              n.vy += ((n.nnY + attrY) - n.y) * 0.06;
            }
            if (PHASE_DRIFT_MS > 0 && cycleMs < PHASE_DRIFT_MS) {
              n.vx += (n.driftHomeX - n.x) * 0.0006;
              n.vy += (n.driftHomeY - n.y) * 0.0006;
            }
            const damp = amt > 0.5 ? 0.86 : 0.94;
            n.vx *= damp; n.vy *= damp;
            n.x += n.vx; n.y += n.vy;
          }
          if (cursorActive && !coarse) {
            const dx = cursorX - n.x, dy = cursorY - n.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < LENS_RADIUS * LENS_RADIUS && distSq > 4) {
              const dist = Math.sqrt(distSq);
              const falloff = 1 - dist / LENS_RADIUS;
              n.brightness = Math.min(1.6, n.brightness + falloff * 0.06);
            }
          }
          n.brightness = Math.max(1, n.brightness * BRIGHTNESS_DECAY);
          n.activation *= NODE_ACTIVATION_DECAY;
        }
        // Set allCoalescedAt once every node has crossed the threshold.
        // Anchors the coalesce pause to the actual last-particle arrival.
        if (allCoalescedAt < 0 && nodes.length > 0 && coalescedCount === nodes.length) {
          allCoalescedAt = now;
        }
      }

      // Firefly update — independent of the network, just drifts upward.
      for (const f of fireflies) {
        const age = now - f.bornAt;
        if (age > f.lifetime || f.y < -20) {
          // Recycle from bottom.
          f.x = Math.random() * width;
          f.y = height + 10;
          f.vx = (Math.random() - 0.5) * 6;
          f.vy = -(FIREFLY_SPEED_MIN + Math.random() * (FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN)) * fireflySpeedMul;
          f.bornAt = now;
          f.lifetime = FIREFLY_LIFETIME_MIN_MS + Math.random() * (FIREFLY_LIFETIME_MAX_MS - FIREFLY_LIFETIME_MIN_MS);
          f.size = 1.5 + Math.random() * 2.5;
          f.hueT = 0.55 + Math.random() * 0.4;
          continue;
        }
        // Horizontal sine sway so they drift not just straight up.
        f.x += f.vx * dt + Math.sin(t * 0.6 + f.phase) * 6 * dt;
        f.y += f.vy * dt;
      }

      const breatheScale = breathing ? 1 + Math.sin(t * (2 * Math.PI / BREATHE_PERIOD_S)) * BREATHE_AMPLITUDE : 1;
      const cx = width / 2, cy = height / 2;

      const visualMul = (n: Node, amt: number) => {
        if (introMode === "fadeIn") return { alpha: amt, sizeMul: 1 };
        if (introMode === "growFromZero") return { alpha: 1, sizeMul: amt };
        if (introMode === "noIntro") return { alpha: 1, sizeMul: 1 };
        return { alpha: amt > 0.05 ? 1 : amt * 20, sizeMul: 1 };
      };

      ctx.clearRect(0, 0, width, height);

      let anyAssembled = alwaysAssembled;
      if (!anyAssembled) {
        for (const n of nodes) if (introAmount(n, cycleMs) > 0.5) { anyAssembled = true; break; }
      }

      const project = (px: number, py: number) => {
        const sx = (px - cx) * breatheScale + cx;
        const sy = (py - cy) * breatheScale + cy;
        return { x: sx, y: sy };
      };

      // Fireflies — render first so they sit behind the network.
      if (fireflies.length > 0) {
        ctx.globalCompositeOperation = "lighter";
        for (const f of fireflies) {
          const age = now - f.bornAt;
          const lifeT = age / f.lifetime;
          // Fade in over first 12%, out over last 25%.
          const lifeFade = lifeT < 0.12 ? lifeT / 0.12
                         : lifeT > 0.75 ? Math.max(0, 1 - (lifeT - 0.75) / 0.25)
                         : 1;
          const twinkle = 0.6 + 0.4 * Math.sin(t * 1.6 + f.phase);
          const excl = exclusionFactor(f.y, height);
          if (excl < 0.05) continue;
          const c = sample(palettePool[f.paletteIdx % palettePool.length] ?? palettePool[0], f.hueT);
          const radius = f.size * (1.4 + twinkle * 0.4);
          const alpha = 0.55 * lifeFade * twinkle * excl;
          const grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius * 2.5);
          grad.addColorStop(0, rgba(c, alpha));
          grad.addColorStop(0.4, rgba(c, alpha * 0.45));
          grad.addColorStop(1, rgba(c, 0));
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(f.x, f.y, radius * 2.5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }

      // Edges.
      ctx.lineCap = "round";
      ctx.globalCompositeOperation = "lighter";
      for (const e of edges) {
        const a = nodes[e.from], b = nodes[e.to];
        const ampA = introAmount(a, cycleMs);
        const ampB = introAmount(b, cycleMs);
        const ampPair = Math.min(ampA, ampB);
        if (ampPair < 0.05 && e.lit < 0.05) continue;
        const parA = parallax * Z_PARALLAX[a.zBand];
        const parB = parallax * Z_PARALLAX[b.zBand];
        const midY = (a.y + b.y) / 2;
        const excl = exclusionFactor(midY, height);
        const baseAlpha = 0.08 * ampPair;
        const litAlpha = e.lit * 0.75;
        const alpha = (baseAlpha + litAlpha) * excl;
        if (alpha < 0.02) continue;
        const c = sample(palettePool[e.paletteIdx % palettePool.length], 0.45 + e.lit * 0.4);
        ctx.strokeStyle = rgba(c, alpha);
        ctx.lineWidth = 0.7 + e.lit * 1.7;
        const pa = project(a.x, a.y - parA);
        const pb = project(b.x, b.y - parB);
        const pc = project(e.cx, e.cy - (parA + parB) / 2);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.quadraticCurveTo(pc.x, pc.y, pb.x, pb.y);
        ctx.stroke();
      }

      // Comet heads.
      for (const c of comets) {
        const e = edges[c.edgeIdx];
        const a = nodes[e.from], b = nodes[e.to];
        const zMix = (Z_PARALLAX[a.zBand] + Z_PARALLAX[b.zBand]) / 2;
        const p = bezierAt(e, c.t);
        const projected = project(p.x, p.y - parallax * zMix);
        const excl = exclusionFactor(p.y, height);
        if (excl < 0.05) continue;
        const headColor = sample(palettePool[c.paletteIdx % palettePool.length], c.hue);
        const radius = 11;
        const grad = ctx.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, radius * 3);
        grad.addColorStop(0, rgba(headColor, 0.9 * excl * c.intensity));
        grad.addColorStop(0.4, rgba(headColor, 0.4 * excl * c.intensity));
        grad.addColorStop(1, rgba(headColor, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(projected.x, projected.y, radius * 3, 0, Math.PI * 2); ctx.fill();
      }

      // Arrival echoes — bright disc at destination that fades over ~280ms.
      for (const ae of arrivalEchoes) {
        const age = now - ae.bornAt;
        const t01 = age / 280;
        const projected = project(ae.x, ae.y);
        const excl = exclusionFactor(ae.y, height);
        if (excl < 0.05) continue;
        const c = sample(palettePool[ae.paletteIdx % palettePool.length], ae.hue);
        const r = 8 + t01 * 22;
        const alpha = (1 - t01) * 0.85 * excl;
        const grad = ctx.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, r * 1.6);
        grad.addColorStop(0, rgba(c, alpha));
        grad.addColorStop(0.5, rgba(c, alpha * 0.4));
        grad.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(projected.x, projected.y, r * 1.6, 0, Math.PI * 2); ctx.fill();
      }

      // Node halos + coalesce rings.
      for (const n of nodes) {
        const amt = introAmount(n, cycleMs);
        const vm = visualMul(n, amt);
        if (vm.alpha < 0.02) continue;
        const projected = project(n.x, n.y - parallax * Z_PARALLAX[n.zBand]);
        const excl = exclusionFactor(n.y, height);
        if (excl < 0.05) continue;
        const twinkle = 0.85 + 0.15 * Math.sin(t * 1.4 + n.phase);
        const visFloor = anyAssembled ? NODE_BASE_BRIGHTNESS : 0.65;
        const totalBright = Math.max(visFloor, n.activation + (n.brightness - 1));
        const haloR = (10 + 18 * Z_SIZE[n.zBand]) * vm.sizeMul * n.brightness * twinkle * (1 + n.activation * 0.7);
        const haloAlpha = totalBright * 0.20 * Z_ALPHA[n.zBand] * excl * twinkle * vm.alpha;
        const c = sample(palettePool[n.paletteIdx % palettePool.length], n.hueT);
        const grad = ctx.createRadialGradient(projected.x, projected.y, 0, projected.x, projected.y, haloR);
        grad.addColorStop(0, rgba(c, haloAlpha));
        grad.addColorStop(0.5, rgba(c, haloAlpha * 0.35));
        grad.addColorStop(1, rgba(c, 0));
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(projected.x, projected.y, haloR, 0, Math.PI * 2); ctx.fill();

        // Coalesce ring — one-shot, expands + fades for COALESCE_RIPPLE_MS.
        if (nodeCoalesce && n.coalescedAt > 0) {
          const ringLifetime = COALESCE_RIPPLE_MS * coalesceRingScale;
          const ringAge = now - n.coalescedAt;
          if (ringAge < ringLifetime) {
            const r01 = ringAge / ringLifetime;
            const ringR = (4 + r01 * 22 * Z_SIZE[n.zBand]) * coalesceRingScale;
            const ringAlpha = (1 - r01) * 0.55 * excl * vm.alpha;
            ctx.strokeStyle = rgba(c, ringAlpha);
            ctx.lineWidth = 1.4 + (coalesceRingScale - 1) * 0.6;
            ctx.beginPath();
            ctx.arc(projected.x, projected.y, ringR, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      if (useCursorTrail) {
        for (let i = 0; i < cursorTrail.length; i++) {
          const tp = cursorTrail[i];
          const age = (now - tp.bornAt) / 800;
          if (age >= 1) continue;
          const alpha = (1 - age) * 0.5;
          const c = sample(palettePool[0 % palettePool.length], 0.85);
          const radius = 14 + (1 - age) * 6;
          const grad = ctx.createRadialGradient(tp.x, tp.y, 0, tp.x, tp.y, radius);
          grad.addColorStop(0, rgba(c, alpha));
          grad.addColorStop(0.5, rgba(c, alpha * 0.4));
          grad.addColorStop(1, rgba(c, 0));
          ctx.fillStyle = grad;
          ctx.beginPath(); ctx.arc(tp.x, tp.y, radius, 0, Math.PI * 2); ctx.fill();
        }
      }

      ctx.globalCompositeOperation = "source-over";

      // Sharp cores.
      for (const n of nodes) {
        const amt = introAmount(n, cycleMs);
        const vm = visualMul(n, amt);
        if (vm.alpha < 0.02) continue;
        const projected = project(n.x, n.y - parallax * Z_PARALLAX[n.zBand]);
        const excl = exclusionFactor(n.y, height);
        if (excl < 0.05) continue;
        const visFloor = anyAssembled ? NODE_BASE_BRIGHTNESS : 0.65;
        const r = (1.5 + 1.6 * Z_SIZE[n.zBand]) * vm.sizeMul * (0.95 + n.activation * 0.6 + n.brightness * 0.2);
        const c = sample(palettePool[n.paletteIdx % palettePool.length], n.hueT);
        const coreAlpha = Math.max(visFloor * 0.55, (0.55 + 0.4 * Z_ALPHA[n.zBand]) * n.brightness) * excl * vm.alpha;
        ctx.fillStyle = rgba(c, coreAlpha);
        ctx.beginPath(); ctx.arc(projected.x, projected.y, r, 0, Math.PI * 2); ctx.fill();
      }

      if (visible && !reduced) frame = requestAnimationFrame(draw);
    };

    if (reduced) draw(performance.now());
    else frame = requestAnimationFrame(draw);

    // IntersectionObserver pause-while-offscreen removed: on iOS WebKit
    // the IO could fire isIntersecting=false initially (canvas 0x0 from
    // late parent layout) and never recover, leaving the loop dead. We
    // accept the cost of computing while the hero is off-screen for
    // reliability.

    // Window-resize fallback alongside ResizeObserver. iOS WebKit's RO
    // timing can miss the initial layout settle (especially with the
    // URL bar collapse on first scroll); window resize fires on
    // orientation change + URL-bar reflow and gives us a second chance
    // to size correctly.
    const onWinResize = () => resize();
    window.addEventListener("resize", onWinResize, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(deferredResizeTimer);
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      window.removeEventListener("scroll", onScroll);
      cursorTarget?.removeEventListener("mousemove", onMove);
      cursorTarget?.removeEventListener("mouseleave", onLeave);
    };
  }, [config]);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
