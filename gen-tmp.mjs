import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "@/lib/firebase/admin",
    "export function getAdminDb() { return globalThis.__TEST_ADMIN_DB__ ?? null; }",
  ],
]);

/**
 * CSS modules resolve to a Proxy that returns the requested key, so
 * `styles.week` renders as `class="week"`. That is what makes §1's frozen
 * markup readable: a hashed build-time class name would turn the snapshot into
 * noise and would change on an unrelated edit.
 */
const CSS_MODULE_STUB =
  "export default new Proxy({}, { get: (_t, key) => (typeof key === 'string' ? key : '') });";

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

let cssStubUrl = null;
function cssUrl() {
  if (!cssStubUrl) cssStubUrl = dataUrl(CSS_MODULE_STUB);
  return cssStubUrl;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  if (file.endsWith(".css")) return cssUrl();
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
      // The automatic runtime, so a component file needs no React import of
      // its own — exactly how Next compiles it.
      jsx: tsc.JsxEmit.ReactJSX,
      jsxImportSource: "react",
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.endsWith(".css")) {
      rewrites.set(specifier, cssUrl());
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed, run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code, not a model.
// ---------------------------------------------------------------------------

const { pickLiveRound } = await loadTs("lib/admissions/liveRound.ts");
const { currentJourneyStepIndex, journeyStepStates } = await loadTs(
  "lib/courses/journeyStep.ts",
);
const { londonDateKey } = await loadTs("lib/courses/weekPlan.ts");
const { compareCatalogueEntries } = await loadTs("features/courses/fetchCourses.ts");
const { default: WeekCurriculum } = await loadTs(
  "features/courses/WeekCurriculum.tsx",
);
const { renderToStaticMarkup } = await import("react-dom/server");

const SAMPLE_WEEK = {
  id: "w3",
  runId: "run-1",
  weekNumber: 3,
  title: "Goal misgeneralisation",
  summary: "Why a model that scores well can still be doing the wrong thing.",
  published: true,
  guideBlocks: [{ id: "b1", type: "richText", html: "<p>Read in this order.</p>" }],
  materials: [
    {
      id: "m1",
      type: "reading",
      title: "Goal misgeneralisation in deep RL",
      url: "https://example.org/paper",
      author: "Langosco et al.",
      estimatedMinutes: 40,
    },
    {
      id: "m2",
      type: "video",
      title: "A short talk",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      estimatedMinutes: 12,
    },
    {
      id: "m3",
      type: "link",
      title: "The interactive demo",
      url: "https://example.org/demo",
      description: "Ten minutes of clicking",
    },
    { id: "m4", type: "note", title: "Skim the appendix", body: "It is short." },
  ],
  exercises: [
    { id: "e1", prompt: "Describe a case you have seen.", responseType: "text" },
  ],
  checklist: [
    { id: "c1", title: "Bring a question", detail: "One is enough.", mirrorToMyWork: false },
  ],
};

import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], renderToStaticMarkup(WeekCurriculum({ week: SAMPLE_WEEK })));
