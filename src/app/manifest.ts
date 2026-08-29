import type { MetadataRoute } from "next";
import { PAGE_FLOOR } from "@/theme/brandColors";

/*
 * Web app manifest, served at /manifest.webmanifest.
 *
 * This is what makes the site installable to the home screen on iOS and
 * Android. It is progressive enhancement and nothing more: a browser that
 * ignores this file sees the site exactly as before, and no service worker is
 * required for either platform to install us (Chrome dropped the fetch-handler
 * requirement in 108 on mobile and 112 on desktop, and iOS 26 installs any
 * site with no requirements at all).
 *
 * Next discovers this file statically and injects <link rel="manifest"> into
 * every page, so the root layout deliberately does NOT set metadata.manifest.
 * mergeStaticMetadata runs after a layout's own metadata and would overwrite
 * an explicit value anyway.
 *
 * The route is a Route Handler, cached by default. Nothing here touches a
 * request-time API, so it prerenders. src/proxy.ts's matcher does not cover
 * /manifest.webmanifest, and browsers fetch manifests uncredentialed, so there
 * is no auth interaction to worry about.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Nottingham AI Safety Initiative",
    // Home-screen labels truncate hard, around 12 characters on iOS.
    short_name: "NAISI",
    description:
      "The AI safety student community at the University of Nottingham.",

    /*
     * Must be "/", not "/dashboard". A signed-out installer opening
     * /dashboard is bounced through proxy.ts to /login, which is a poor first
     * launch. "/" is also the only route with revalidate = 600, so it is the
     * fastest cold start we have. Returning a signed-in member to where they
     * were is a separate concern and does not belong in start_url.
     */
    start_url: "/",
    /*
     * The whole origin. Has to cover /login and the (app) tree. Scope is
     * same-origin only and can never include accounts.google.com, so it has no
     * bearing on the Google sign-in flow.
     */
    scope: "/",

    /*
     * No display_override. The only member worth having would be
     * window-controls-overlay, which needs a titlebar drag region designed
     * into AppShell, and the spec's standalone to minimal-ui to browser
     * fallback chain already covers everything else.
     */
    display: "standalone",

    /*
     * Explicitly unlocked rather than omitted, so the intent is on the record.
     * /committee/tasks is a horizontally scrolling kanban that is better in
     * landscape, and locking orientation is hostile to anyone using a rotated
     * or mounted device.
     */
    orientation: "any",

    lang: "en",
    dir: "ltr",
    categories: ["education"],

    /*
     * One value for both. background_color fills the Android splash screen and
     * theme_color tints the standalone status bar, so matching them means the
     * two form a single flat field with no seam. See brandColors.ts for why
     * #050810 and not --color-bg or the authed top strip's composite.
     */
    background_color: PAGE_FLOOR,
    theme_color: PAGE_FLOOR,

    /*
     * Icon.purpose is a single-value union in Next's types, so the combined
     * "any maskable" string is a type error here. Separate files are forced,
     * which is what web.dev recommends anyway: a maskable icon needs a much
     * larger safe zone and looks over-padded when used as a plain icon.
     */
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],

    /*
     * Android's long-press menu, and macOS Safari 17.4+. iOS ignores these.
     * Labels match the AppShell sidebar verbatim so the menu and the app agree.
     * All three are role-gated, so a signed-out tap lands on /login?next=...,
     * which is a reasonable outcome rather than a broken one.
     */
    /*
     * Android: launching from the icon focuses the existing app window
     * instead of navigating it back to start_url, which preserves where the
     * member was with no code at all. Safari ignores this member entirely,
     * which is why RelaunchRestore.tsx exists for iOS.
     */
    launch_handler: { client_mode: "focus-existing" },

    shortcuts: [
      { name: "Dashboard", url: "/dashboard" },
      { name: "My work", url: "/tasks" },
      { name: "Courses", url: "/learn" },
    ],
  };
}
