// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runtime cache names, and the cleanup a worker runs on activation.
 *
 *   A cache of the build's own files takes the name `<prefix><role>-<build>`,
 *   because a file there may keep its URL while its bytes change between builds.
 *
 *   A cache of versioned data, such as release files or range chunks, takes the name
 *   `<prefix><role>`, with no build, so a deploy keeps it.
 *   Its entries leave through a release prune message or an entry cap rather than through a deploy.
 *
 *   {@linkcode deleteOtherBuildCaches} on activation deletes every other cache under the prefix.
 *   That covers an earlier build's caches, including data caches that an earlier
 *   worker keyed by build commit.
 */

/**
 * The name of one role's cache for one build, such as `mailwoman-app-assets-5b13e9a1c`.
 */
export function buildCacheName(prefix: string, role: string, build: string): string {
	return `${prefix}${role}-${build}`
}

/**
 * The name of one role's cache that every build shares, such as `mailwoman-tiles`.
 */
export function roleCacheName(prefix: string, role: string): string {
	return `${prefix}${role}`
}

/**
 * The name of one role's cache at a hand-bumped generation, such as `mailwoman-tiles-g1`.
 *
 * Every build shares it until a deploy raises the generation.
 * Activation then deletes the earlier generation's cache, as it deletes every cache outside the current set.
 */
export function generationCacheName(prefix: string, role: string, generation: number): string {
	return `${prefix}${role}-g${generation}`
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
