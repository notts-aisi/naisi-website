/*
 * Brand colours that TypeScript needs.
 *
 * CSS custom properties cannot be read from TS, and CSS files cannot be
 * imported into a metadata module, so the handful of colours the web app
 * manifest and the <meta name="theme-color"> tag need are mirrored here.
 * Same mirroring convention as breakpoints.ts <-> tokens.css, for the same
 * reason.
 *
 * PAGE_FLOOR must stay in sync with `body { background }` in
 * src/app/globals.css.
 */

/**
 * The true page floor.
 *
 * Deliberately darker than --color-bg (#0a0e16) so it matches the hero
 * atmosphere's outer stop and cross-layout transitions do not seam. See the
 * comment on `body` in globals.css for the original reasoning.
 *
 * Used for three things, all of which want the same value so the installed
 * app has no visible seam between them:
 *   - the manifest's background_color (the Android splash screen fill)
 *   - the manifest's theme_color (the standalone status bar tint)
 *   - viewport.themeColor (Chrome on Android's address bar in a normal tab)
 *
 * The three candidate top-edge colours, computed from the real CSS, are
 * #090d15 (PublicHeader, --color-bg at 85% over the floor), #050810 (the
 * auth shell, which paints the floor literally) and #101624 (AppShell's
 * .topStrip, --color-bg-elevated at 92% over the floor). #050810 is the
 * darkest and sits within 11/255 of all three, so white status-bar glyphs
 * keep maximum contrast on every surface and none of them looks wrong.
 */
export const PAGE_FLOOR = "#050810";
