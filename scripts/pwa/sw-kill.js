/*
 * KILL SWITCH worker. The secondary rollback lever for the service worker.
 *
 * Use when the registrar itself is suspect (the primary lever is flipping
 * SERVICE_WORKER_ENABLED in src/features/pwa/config.ts). Deploy by copying
 * this file over public/sw.js and merging:
 *
 *     cp scripts/pwa/sw-kill.js public/sw.js
 *
 * Browsers see a byte-different sw.js on their next update check (update
 * checks bypass HTTP cache thanks to updateViaCache: "none" and the
 * no-cache header), install it, and on activate it deletes every cache on
 * the origin, unregisters itself, and reloads open windows so they are
 * controller-free immediately.
 *
 * The KILL SWITCH sentinel above is load-bearing: tests/pwa-offline-assets
 * .test.mjs skips its write-nothing assertions when public/sw.js contains
 * it, so deploying this file cannot fail npm test at the worst moment.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      await Promise.all(clients.map((c) => c.navigate(c.url)));
    })(),
  );
});
