/*
 * The service worker's master switch, and the rollback lever.
 *
 * Flip to false and merge: on every visitor's next page load the registrar
 * unregisters every worker on this origin and deletes every naisi- cache.
 * That is the PRIMARY rollback path, and it works because this constant
 * ships inside the app bundle, which is never served from a cache the
 * worker controls (the worker caches only /offline.html by contract).
 *
 * The secondary lever, for when the registrar itself is suspect, is
 * deploying scripts/pwa/sw-kill.js over public/sw.js. See docs/pwa.md.
 */
export const SERVICE_WORKER_ENABLED = true;
