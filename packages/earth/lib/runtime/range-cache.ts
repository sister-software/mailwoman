// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The page's half of the range-cache protocol in `service-worker.ts`: the worker persists every validated 64 KB range
 * chunk of the byte-range databases under an immutable, versioned URL, so the page must name the release whose chunks
 * stay cached. Everything here is best-effort — no service worker support (insecure context, private mode) degrades
 * to plain network range fetches.
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
			/* no active worker — no cache to prune */
		})
}
