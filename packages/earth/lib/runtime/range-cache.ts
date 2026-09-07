/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The page's half of the range-cache protocol with the app's service worker (`service-worker.ts`): the message that
 *   names the release whose gazetteer chunks stay cached. The worker persists every validated 64 KB range chunk of the
 *   byte-range databases under an immutable, versioned URL, so chunks from other releases never expire on their own
 *   and the page has to say which release it is on. Everything here is best-effort: no service worker support
 *   (insecure context, private mode) degrades to plain network range fetches.
 */

/**
 * The one message the service worker understands.
 */
export const PRUNE_MESSAGE_TYPE = "mailwoman-prune-db-ranges"

export interface PruneMessage {
	type: typeof PRUNE_MESSAGE_TYPE
	keepVersion: string
}

/**
 * Ask the service worker to drop cached DB range chunks from releases other than `keepVersion`.
 */
export function pruneDBRangeCache(keepVersion: string): void {
	if (globalThis.window === undefined || !("serviceWorker" in navigator)) return

	const message: PruneMessage = { type: PRUNE_MESSAGE_TYPE, keepVersion }

	void navigator.serviceWorker.ready
		.then((registration) => registration.active?.postMessage(message))
		.catch(() => {
			/* no active worker — nothing to prune */
		})
}
