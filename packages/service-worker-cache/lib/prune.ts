// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The page-to-worker message that drops cached files of releases the page no longer reads, and the cache walk the
 *   worker runs for it. A release's files live under a release-version path segment, such as `v10.8.0` in
 *   `/mailwoman/en-us/v10.8.0/model.onnx`. Files outside any release, such as the gazetteer's
 *   `/mailwoman/gazetteer/2026-08-25b/candidate.db`, have no such segment in their path and are kept.
 */

/**
 * A release-version path segment: a semantic version with an optional leading `v`
 * and an optional suffix, such as `/v10.8.0/` or `/10.8.0-rc.1/`.
 *
 * A dated version such as `/2026-08-25b/` and a bare `/v2/` do not match.
 */
const RELEASE_VERSION_SEGMENT = /\/(v?\d+\.\d+\.\d+[^/]*)\//u

/**
 * The `type` of {@linkcode PruneMessage}.
 */
export const PRUNE_MESSAGE_TYPE = "mailwoman-prune-db-ranges"

/**
 * Asks the service worker to keep only the entries of `keepVersion` in the caches it prunes.
 */
export interface PruneMessage {
	type: typeof PRUNE_MESSAGE_TYPE
	keepVersion: string
}

export function isPruneMessage(data: unknown): data is PruneMessage {
	if (typeof data !== "object" || data == null) return false

	const { type, keepVersion } = data as { type?: unknown; keepVersion?: unknown }

	return type === PRUNE_MESSAGE_TYPE && typeof keepVersion === "string"
}

/**
 * Deletes every entry of `cache` whose URL path holds a release-version segment
 * other than `keepVersion`, and returns the number deleted.
 *
 * An entry whose path holds no release-version segment is kept.
 */
export async function pruneOtherVersions(cache: Pick<Cache, "keys" | "delete">, keepVersion: string): Promise<number> {
	let deleted = 0

	for (const request of await cache.keys()) {
		const version = RELEASE_VERSION_SEGMENT.exec(new URL(request.url).pathname)?.[1]

		if (version != null && version !== keepVersion && (await cache.delete(request))) {
			deleted++
		}
	}

	return deleted
}

/**
 * Posts a {@linkcode PruneMessage} to the page's active service worker.
 *
 * A page without service-worker support, such as one in an insecure context,
 * has no cache to prune, and the call returns without posting.
 */
export function postPruneMessage(keepVersion: string): void {
	if (!globalThis.window || !("serviceWorker" in navigator)) return

	const message: PruneMessage = { type: PRUNE_MESSAGE_TYPE, keepVersion }

	void navigator.serviceWorker.ready
		.then((registration) => registration.active?.postMessage(message))
		.catch(() => {
			// A page with no active worker has no cache to prune.
		})
}
