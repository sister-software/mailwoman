// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Opens Earth's range-read databases once the service worker controls the page.
 *
 *   The service worker stores each range in Cache Storage for offline use, and answers 502
 *   when the network sends the whole file instead of the range.
 *   A range worker takes its controller from the page when it starts, so a worker started
 *   before the first visit's service worker claims the page bypasses both for its whole life.
 */

import type { RangeDatabase } from "@mailwoman/resolver-wof-wasm/httpvfs/database"
import { serviceWorkerControl } from "@mailwoman/universe/site-kit/service-worker-client"

/**
 * How long the first visit waits for its service worker to install and claim the page.
 *
 * The install downloads the precache, about 1.9 MB compressed.
 * A 1 Mbit/s link transfers that in about 16 s.
 * A page that times out opens its databases uncontrolled.
 *
 * The range worker's first read then still refuses a whole-file answer before reading its body.
 */
const SERVICE_WORKER_CONTROL_TIMEOUT_MS = 15_000

let control: Promise<unknown> | null = null

/**
 * Resolves once a service worker controls the page.
 *
 * A development build registers no service worker, so there it resolves at once.
 */
function pageControl(): Promise<unknown> {
	control ??= import.meta.env.PROD ? serviceWorkerControl(SERVICE_WORKER_CONTROL_TIMEOUT_MS) : Promise.resolve()

	return control
}

/**
 * Opens the database at `url` for range reads, after the page's service worker controls it.
 */
export async function openEarthRangeDatabase(url: string, sqliteRuntimeBaseURL: string): Promise<RangeDatabase> {
	const [{ openRangeDatabase }] = await Promise.all([
		import("@mailwoman/resolver-wof-wasm/httpvfs/database"),
		pageControl(),
	])

	return openRangeDatabase(url, sqliteRuntimeBaseURL)
}
