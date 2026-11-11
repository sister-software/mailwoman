/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cache names scoped to one build. A worker that names its caches `<prefix><role>-<build>` and runs
 *   {@linkcode deleteOtherBuildCaches} on activation starts every cache empty after a deploy. A release asset or tile
 *   from an earlier build is fetched again once, so a deploy can never leave a stale copy behind.
 */

/**
 * The name of one role's cache for one build, such as `mailwoman-tiles-5b13e9a1c`.
 */
export function buildCacheName(prefix: string, role: string, build: string): string {
	return `${prefix}${role}-${build}`
}

/**
 * Deletes every cache whose name starts with `prefix` and isn't in `keep`, and returns the names deleted.
 *
 * A cache outside the prefix is kept.
 * Workbox's precache is one, and Workbox replaces its entries by revision.
 */
export async function deleteOtherBuildCaches(
	storage: Pick<CacheStorage, "keys" | "delete">,
	prefix: string,
	keep: ReadonlySet<string>
): Promise<string[]> {
	const deleted: string[] = []

	for (const name of await storage.keys()) {
		if (name.startsWith(prefix) && !keep.has(name) && (await storage.delete(name))) {
			deleted.push(name)
		}
	}

	return deleted
}
