/*
 * NAISI service worker. Deliberately write-nothing.
 *
 * THE CONTRACT (change it here first, then the code):
 *
 *   The ONLY Cache Storage write in this file is the single
 *   cache.add("/offline.html") in `install`. The fetch handler responds to
 *   exactly one class of request: same-origin GET navigations. Everything
 *   else returns early with no respondWith, so this worker is not even in
 *   the request path for subresources, /_next/static/** (content-hashed
 *   chunks and fonts), /api/**, RSC ?_rsc= fetches, Firestore's WebChannel,
 *   Storage, GIS, or auth.naisi.uk.
 *
 * Why so austere:
 *
 *   - Caching HTML on this stack bricks deploys. Firebase App Hosting
 *     rebuilds a container per rollout and does NOT keep the previous
 *     build's /_next/static/* addressable, so a cached document referencing
 *     old chunk hashes is an unrecoverable white screen after the next
 *     deploy. Never precache HTML routes, never runtime-cache navigations.
 *   - Authed HTML is per-role. getCurrentUser() in (app)/layout.tsx renders
 *     role-gated content server-side, so a cached authed document would bake
 *     one user's view into a shared device. Structural exclusion beats a
 *     denylist that someone can get wrong later.
 *   - Because nothing but /offline.html is ever served from cache,
 *     skipWaiting + clients.claim are SAFE here (there is no cached bundle
 *     an in-flight page could half-load from two builds), updates are
 *     invisible, and no "new version available, reload" UX is needed. Do
 *     not add a controllerchange reload listener: it would race the
 *     hardNavigate() full-document loads the auth flow performs.
 *   - <a download> requests (the ICS calendar export, CSV exports) are not
 *     mode: "navigate", so they fall through untouched. If the fetch
 *     handler is ever broadened, keep it that way.
 *
 * The push and notificationclick handlers ship now, before any push feature
 * exists, so adding web push later is a server-side project rather than a
 * service-worker rework. They are inert until a subscription exists.
 *
 * Versioning: bump SW_VERSION on any change to this file. The byte diff is
 * what makes browsers install the update; the version string keys the cache
 * so activate can delete stale ones.
 *
 * Rollback: flip SERVICE_WORKER_ENABLED in src/features/pwa/config.ts (the
 * registrar then unregisters everything and deletes our caches), or deploy
 * scripts/pwa/sw-kill.js as public/sw.js. See docs/pwa.md.
 */

const SW_VERSION = "v2";
const CACHE_NAME = `naisi-${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // cache.add fetches with default (non-credentialed for same-origin is
      // fine here; the page is public and static). If this fetch fails the
      // install fails and the previous worker, if any, stays active, which
      // is the correct outcome.
      await cache.add(OFFLINE_URL);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Start the network fetch in parallel with worker startup on
      // navigations. Without this, a cold worker adds its own boot time to
      // every page load it intercepts.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      // Drop caches from previous versions of this worker. Scoped to our
      // own naisi- prefix so nothing else's storage is touched.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("naisi-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // The one class of request this worker answers: a same-origin GET
  // navigation. Everything else falls through to the network untouched
  // (no respondWith at all).
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        // Use the preloaded response when navigation preload already has
        // one in flight; otherwise pass the ORIGINAL request through so
        // redirect semantics are preserved (proxy.ts's 307 to /login must
        // keep working exactly as it does without a worker).
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        // A genuine network failure (offline, DNS, airplane mode), not an
        // HTTP error: fetch resolves on 4xx/5xx, so those pass through
        // above and render the site's own error pages.
        const cache = await caches.open(CACHE_NAME);
        const offline = await cache.match(OFFLINE_URL);
        // If the offline page is somehow missing, re-throwing produces the
        // browser's native error page, same as no worker at all.
        if (offline) return offline;
        throw new Error("offline fallback missing");
      }
    })(),
  );
});

/*
 * Web push. Inert until a push subscription exists (a later PR: VAPID keys,
 * a pushSubscriptions collection, a permission prompt from a user gesture).
 *
 * event.waitUntil around showNotification is MANDATORY, not defensive
 * boilerplate: without it the event can end before the notification
 * renders, iOS scores that as a silent push, and Safari revokes the
 * subscription after roughly three of those. That revocation is the single
 * most reported way iOS web push silently dies.
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  // The server sends the Declarative Web Push envelope (web_push: 8030 with
  // a `notification` member; see src/lib/push/send.ts). Safari 18.4+ renders
  // that WITHOUT waking this handler; Chromium and Firefox land here, so the
  // envelope's fields are read first with the bare legacy shape as fallback.
  const n = payload.notification || payload;
  const title = n.title || "NAISI";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: n.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: n.navigate || n.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse an existing window when one is open; a notification tap
      // spawning a second copy of the app is disorienting.
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client && new URL(client.url).pathname !== target) {
            await client.navigate(target);
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
