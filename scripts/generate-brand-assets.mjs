/**
 * Generates the optimized NAISI brand assets used across the site, emails, and
 * favicon from the two master logo files in `brand-source/`.
 *
 *   brand-source/NAISI_logo_without_name.png  -> emblem (castle + shield + head)
 *   brand-source/NAISI_logo_with_name.png     -> emblem + stacked wordmark
 *
 * Run after the master files change:  node scripts/generate-brand-assets.mjs
 *
 * Outputs (all committed to the repo):
 *   public/brand/naisi-emblem.png        emblem, original navy/cyan colorway
 *   public/brand/naisi-emblem-white.png  emblem, monochrome white (dark UI)
 *   public/brand/naisi-lockup.png        emblem + wordmark, original colorway
 *   src/app/icon.png                     favicon, white emblem on the page floor
 *   src/app/apple-icon.png               apple touch icon, same treatment
 *   public/icons/icon-192.png            web app manifest icon, purpose "any"
 *   public/icons/icon-512.png            web app manifest icon, purpose "any"
 *   public/icons/icon-maskable-512.png   web app manifest icon, purpose "maskable"
 *   public/offline.html                  offline fallback, emblem inlined as a
 *                                        data URI from scripts/offline-template.html
 *
 * Why a white emblem is generated here: the master logo is a dark navy/cyan
 * colorway that sinks into the near-black site background. The emblem is a
 * dark navy shape with a bright cyan offset-shadow behind it; we drop the cyan
 * (it would double the edge when flattened) and render the navy shape white.
 *
 * Why every app icon uses that white emblem on the dark page floor rather than
 * the original colorway on white: Android crops launcher icons to a circle or
 * squircle, and a white tile letterboxes badly inside that mask, so the icon
 * reads as a pale blob rather than as NAISI. A dark ground fills the mask edge
 * to edge and matches the app the icon opens. The original navy/cyan emblem is
 * invisible on #050810, so the dark ground forces the whitened variant. The
 * favicon and the apple touch icon use the same treatment so one app does not
 * show two different icons across platforms.
 */
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_EMBLEM = path.join(root, "brand-source/NAISI_logo_without_name.png");
const SRC_LOCKUP = path.join(root, "brand-source/NAISI_logo_with_name.png");

/*
 * The site's page floor. Mirrored from `body { background }` in
 * src/app/globals.css and from PAGE_FLOOR in src/theme/brandColors.ts.
 * Hardcoded rather than imported because this is a plain .mjs script and
 * cannot import a .ts module. Keep all three in sync.
 */
const PAGE_FLOOR = "#050810";

/** Tile options shared by every app icon. See tile() for what each field does. */
const ICON_ANY = { pad: 0.12, background: PAGE_FLOOR, flatten: true };
const ICON_MASKABLE = { pad: 0.195, background: PAGE_FLOOR, flatten: true };

/** Re-encode as an optimized, palette-quantized PNG. */
const png = (img) => img.png({ palette: true, compressionLevel: 9 });

/** Recolor every kept pixel white, dropping the cyan offset-shadow. */
async function whiten(srcBuffer) {
  const { data, info } = await sharp(srcBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4;
    const g = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    // Cyan accent is bright in both green and blue; the navy body is dark.
    const isCyan = g > 150 && b > 150;
    if (a === 0 || isCyan) continue; // leave transparent
    out[o] = out[o + 1] = out[o + 2] = 255;
    out[o + 3] = a;
  }
  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
  });
}

/**
 * Composite an emblem, padded, onto a square opaque tile.
 *
 * @param pad        fraction of `size` reserved as padding on each edge.
 *                   0.12 for favicons and for manifest icons with
 *                   purpose "any"; 0.195 for a maskable icon (see below).
 * @param background tile ground.
 * @param flatten    drop the alpha channel. iOS composites any transparency
 *                   in a home-screen icon onto black, and Android does the
 *                   same inside an adaptive mask, so app icons must be fully
 *                   opaque rather than relying on the create() background
 *                   showing through.
 */
async function tile(emblemBuffer, size, { pad = 0.12, background = "#ffffff", flatten = false } = {}) {
  const padPx = Math.round(size * pad);
  const inner = await sharp(emblemBuffer)
    .resize({ height: size - padPx * 2, fit: "inside" })
    .toBuffer();
  const img = sharp({
    create: { width: size, height: size, channels: 4, background },
  }).composite([{ input: inner, gravity: "center" }]);
  return (flatten ? img.flatten({ background }) : img).png();
}

async function report(label, file) {
  const meta = await sharp(file).metadata();
  console.log(
    `  ${label.padEnd(26)} ${meta.width}x${meta.height}  ar(w/h)=${(
      meta.width / meta.height
    ).toFixed(4)}`,
  );
}

async function main() {
  // Emblem, original colorway. Used in emails (light background).
  const emblem = await png(
    sharp(await sharp(SRC_EMBLEM).trim().toBuffer()).resize({ height: 480 }),
  ).toBuffer();
  await sharp(emblem).toFile(path.join(root, "public/brand/naisi-emblem.png"));

  // Emblem, monochrome white. Used on every dark site surface.
  const emblemWhite = await png(
    (await whiten(await sharp(SRC_EMBLEM).trim().toBuffer()))
      .trim()
      .resize({ height: 480 }),
  ).toBuffer();
  await sharp(emblemWhite).toFile(
    path.join(root, "public/brand/naisi-emblem-white.png"),
  );

  // Full stacked lockup, original colorway. Kept for press / general use.
  await png(
    sharp(await sharp(SRC_LOCKUP).trim().toBuffer()).resize({ width: 480 }),
  ).toFile(path.join(root, "public/brand/naisi-lockup.png"));

  // Favicon + apple touch icon: the white emblem on the page floor. Opaque,
  // because iOS composites any transparency in a home-screen icon onto black.
  // Same artwork as the manifest icons below so the Safari tab, the iOS home
  // screen and the Android launcher all show one icon.
  await png(await tile(emblemWhite, 256, ICON_ANY)).toFile(
    path.join(root, "src/app/icon.png"),
  );
  await png(await tile(emblemWhite, 180, ICON_ANY)).toFile(
    path.join(root, "src/app/apple-icon.png"),
  );

  // Web app manifest icons. Kept separate from the favicons above because they
  // are OS-facing (Android launcher, task switcher, the Chrome install dialog
  // and its splash screen) and are referenced by literal URL from
  // src/app/manifest.ts, which cannot name the content-hashed URLs Next serves
  // src/app/icon.png from.
  const iconsDir = path.join(root, "public/icons");
  await mkdir(iconsDir, { recursive: true });

  for (const size of [192, 512]) {
    await png(await tile(emblemWhite, size, ICON_ANY)).toFile(
      path.join(iconsDir, `icon-${size}.png`),
    );
  }

  // purpose: "maskable". Android crops adaptive icons to an arbitrary shape and
  // guarantees only a centre circle of radius 40% of the icon width, so the
  // artwork needs a much bigger safe zone than a favicon.
  //
  // Deriving the 0.195 pad rather than guessing it: the white emblem is 391x480
  // (aspect 0.8146). The safe circle at 512px has diameter 0.8 * 512 = 409.6px.
  // A 0.195 pad is round(512 * 0.195) = 100px per edge, leaving a 312px-tall
  // emblem, so 254x312, whose half-diagonal is 201.2px. That sits inside the
  // 204.8px safe radius with a little room, and a larger pad would start to
  // shrink the emblem for no benefit. Recompute this if the master art's aspect
  // ratio ever changes.
  await png(await tile(emblemWhite, 512, ICON_MASKABLE)).toFile(
    path.join(iconsDir, "icon-maskable-512.png"),
  );

  // Offline fallback page. Rendered from the committed template with the
  // white emblem inlined as a data URI, because this is the one document the
  // service worker serves with no network: it cannot reference an image URL,
  // and /_next/* asset paths die with every deploy. 72px display size, 144px
  // bitmap for retina.
  const emblemSmall = await sharp(emblemWhite)
    .resize({ height: 144, fit: "inside" })
    .png({ palette: true, compressionLevel: 9 })
    .toBuffer();
  const template = await readFile(
    path.join(root, "scripts/offline-template.html"),
    "utf8",
  );
  const banner =
    "<!-- GENERATED from scripts/offline-template.html by scripts/generate-brand-assets.mjs. Do not edit directly. -->\n";
  await writeFile(
    path.join(root, "public/offline.html"),
    banner +
      template.replace(
        "__EMBLEM_DATA_URI__",
        `data:image/png;base64,${emblemSmall.toString("base64")}`,
      ),
  );

  console.log("Brand assets generated:");
  await report("public/brand/naisi-emblem", path.join(root, "public/brand/naisi-emblem.png"));
  await report("public/brand/...-white", path.join(root, "public/brand/naisi-emblem-white.png"));
  await report("public/brand/naisi-lockup", path.join(root, "public/brand/naisi-lockup.png"));
  await report("src/app/icon", path.join(root, "src/app/icon.png"));
  await report("src/app/apple-icon", path.join(root, "src/app/apple-icon.png"));
  await report("public/icons/icon-192", path.join(root, "public/icons/icon-192.png"));
  await report("public/icons/icon-512", path.join(root, "public/icons/icon-512.png"));
  await report("public/icons/...maskable", path.join(root, "public/icons/icon-maskable-512.png"));
  const offlineBytes = (await readFile(path.join(root, "public/offline.html"))).length;
  console.log(`  ${"public/offline.html".padEnd(26)} ${(offlineBytes / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
