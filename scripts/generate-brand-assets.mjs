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
 *   src/app/icon.png                     favicon, emblem on a white tile
 *   src/app/apple-icon.png               apple touch icon, emblem on white
 *
 * Why a white emblem is generated here: the master logo is a dark navy/cyan
 * colorway that sinks into the near-black site background. The emblem is a
 * dark navy shape with a bright cyan offset-shadow behind it; we drop the cyan
 * (it would double the edge when flattened) and render the navy shape white.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_EMBLEM = path.join(root, "brand-source/NAISI_logo_without_name.png");
const SRC_LOCKUP = path.join(root, "brand-source/NAISI_logo_with_name.png");

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

/** Composite an emblem, padded, onto a square white favicon tile. */
async function tile(emblemBuffer, size) {
  const pad = Math.round(size * 0.12);
  const inner = await sharp(emblemBuffer)
    .resize({ height: size - pad * 2, fit: "inside" })
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: "#ffffff" },
  })
    .composite([{ input: inner, gravity: "center" }])
    .png();
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

  // Favicons: the original-colorway emblem on a white tile so it reads in both
  // light and dark browser chrome.
  await (await tile(emblem, 256)).toFile(path.join(root, "src/app/icon.png"));
  await (await tile(emblem, 180)).toFile(
    path.join(root, "src/app/apple-icon.png"),
  );

  console.log("Brand assets generated:");
  await report("public/brand/naisi-emblem", path.join(root, "public/brand/naisi-emblem.png"));
  await report("public/brand/...-white", path.join(root, "public/brand/naisi-emblem-white.png"));
  await report("public/brand/naisi-lockup", path.join(root, "public/brand/naisi-lockup.png"));
  await report("src/app/icon", path.join(root, "src/app/icon.png"));
  await report("src/app/apple-icon", path.join(root, "src/app/apple-icon.png"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
