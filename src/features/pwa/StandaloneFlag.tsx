/**
 * Stamps `data-standalone` and `data-standalone-ios` on <html> BEFORE first
 * paint, so CSS can react to being an installed app with no flash.
 *
 * Why an inline script rather than the useIsStandalone hook: the hook
 * deliberately returns false on the server and on the first client render, so
 * anything driven by it changes at hydration. For a colour or a hidden button
 * that is fine. For layout, on the very first screen of a freshly launched
 * app, it is a visible jump. This is the same pre-paint pattern theme
 * switchers use for exactly the same reason.
 *
 * Server-rendered output is byte-identical for every visitor. The attributes
 * only ever appear on a device where the site is genuinely installed, so a
 * browser tab is untouched.
 *
 * Kept deliberately tiny and wrapped in try/catch: it runs before anything
 * else and must never be the reason a page fails to render.
 */

// Minified by hand because it ships inline on every page. Expanded:
//   const standalone = matchMedia('(display-mode: standalone)').matches
//     || matchMedia('(display-mode: fullscreen)').matches
//     || navigator.standalone === true;
//   if (standalone) {
//     root.dataset.standalone = 'true';
//     // iPadOS 13+ reports a Mac UA, so maxTouchPoints disambiguates.
//     if (/iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) {
//       root.dataset.standaloneIos = 'true';
//     }
//   }
const SCRIPT = `try{var m=window.matchMedia,u=navigator.userAgent;if(m('(display-mode: standalone)').matches||m('(display-mode: fullscreen)').matches||navigator.standalone===true){var d=document.documentElement;d.dataset.standalone='true';if(/iPad|iPhone|iPod/.test(u)||(u.indexOf('Macintosh')>-1&&navigator.maxTouchPoints>1)){d.dataset.standaloneIos='true'}}}catch(e){}`;

export function StandaloneFlag() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
