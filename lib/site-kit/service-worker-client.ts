// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page side of an app's service worker.
 *
 *   An app's worker calls `skipWaiting` and `clients.claim`, so a deploy's new worker
 *   takes control of an open page right after it installs.
 *   The page itself keeps running the JavaScript the previous worker served,
 *   while every fetch it makes from then on reaches current data, such as a releases
 *   manifest that points at a model the old code cannot load.
 *
 *   A single reload on that takeover makes the page run the code the new worker serves.
 */

/**
 * Reloads the page once when a new service worker takes control of a page an earlier worker served.
 *
 * A first visit has no controlling worker, so its first worker's takeover doesn't reload the page.
 */
export function reloadOnServiceWorkerTakeover(): void {
	if (!("serviceWorker" in navigator)) return

	const servedByEarlierWorker = Boolean(navigator.serviceWorker.controller)
	let reloading = false

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!servedByEarlierWorker || reloading) return

		reloading = true
		globalThis.location.reload()
	})
}
