#!/usr/bin/env node
/*
 * Breakpoint lint guard. Fails if any `.css` file in src/** uses a
 * (min-width|max-width) value outside the canonical set defined in
 * src/theme/breakpoints.ts and docs/mobile-conventions.md.
 *
 * Canonical (rem): 36, 48, 60, 80  → sm, md, lg, xl
 *
 * Exempt (mobile-frozen — see docs/mobile-baseline-events.md):
 *   src/features/events/EventDetailView.module.css
 *   src/features/events/RsvpForm.module.css
 *   src/features/events/BlockView.module.css
 *   src/features/events/FormRenderer.module.css
 *   src/features/events/CoverImage.module.css
 *
 * Wired into `npm run lint`; also runnable standalone as `npm run lint:bp`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL_REM = new Set([36, 48, 60, 80]);

const EXEMPT = new Set([
  "src/features/events/EventDetailView.module.css",
  "src/features/events/RsvpForm.module.css",
  "src/features/events/BlockView.module.css",
  "src/features/events/FormRenderer.module.css",
  "src/features/events/CoverImage.module.css",
]);

const WIDTH_RE = /\((min|max)-width:\s*([\d.]+)(rem|px)\s*\)/g;

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile() && ent.name.endsWith(".css")) {
      yield full;
    }
  }
}

const violations = [];
let filesScanned = 0;

for (const file of walk("src")) {
  filesScanned += 1;
  if (EXEMPT.has(file)) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("@media")) continue;

    WIDTH_RE.lastIndex = 0;
    let m;
    while ((m = WIDTH_RE.exec(line)) !== null) {
      const [match, , raw, unit] = m;
      const rem = unit === "rem" ? parseFloat(raw) : parseFloat(raw) / 16;
      if (!CANONICAL_REM.has(rem)) {
        violations.push(`${file}:${i + 1}  ${match}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Non-canonical breakpoints found. Canonical: 36rem, 48rem, 60rem, 80rem (sm / md / lg / xl).",
  );
  console.error("See docs/mobile-conventions.md for the convention.\n");
  for (const v of violations) console.error("  " + v);
  console.error(
    `\n${violations.length} violation${violations.length === 1 ? "" : "s"} across ${filesScanned} CSS file${filesScanned === 1 ? "" : "s"}.`,
  );
  process.exit(1);
}

console.log(`Breakpoint check: ${filesScanned} CSS file${filesScanned === 1 ? "" : "s"} scanned, all canonical.`);
