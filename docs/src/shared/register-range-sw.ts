/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Registration shim for the DB range-chunk service worker (`static/range-cache-sw.js`). The SW
 *   persists validated 64 KB range chunks of the sql.js-httpvfs databases in Cache Storage so
 *   repeat visits resolve with little-to-no network, and torn chunks (the mobile-Safari HTTP-cache
 *   failure mode) never reach SQLite. See the SW file header for the protocol.
 *
 *   Everything here is best-effort: no service worker support (insecure context, old browser, private
 *   mode restrictions) silently degrades to plain network range fetches.
 */

/** Message type understood by the range-cache service worker. */
const PRUNE_MESSAGE_TYPE = "mailwoman-prune-db-ranges"

/** Register the range-cache service worker. Idempotent — repeat calls re-use the registration. */
export function registerRangeCacheServiceWorker(baseUrl: string): void {
	if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
	void navigator.serviceWorker.register(`${baseUrl}range-cache-sw.js`).catch((error: unknown) => {
		console.warn("[mailwoman demo] range-cache service worker registration failed", error)
	})
}

/**
 * Ask the service worker to drop cached DB range chunks from versions other than `keepVersion`. The
 * asset URLs are versioned + immutable, so stale versions' chunks never expire on their own.
 */
export function pruneDbRangeCache(keepVersion: string): void {
	if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
	void navigator.serviceWorker.ready
		.then((registration) => registration.active?.postMessage({ type: PRUNE_MESSAGE_TYPE, keepVersion }))
		.catch(() => {
			/* no active SW — nothing to prune */
		})
}
