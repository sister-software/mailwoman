/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Small collection folds shared across build pipelines.
 */

/**
 * Fold `[key, count]` entries into `target`, ADDING counts rather than replacing them — the merge every chunked build's
 * aggregation repeats. Why the counts add is a fact about each product's chunking, stated at its call site.
 */
export function mergeCountsInto<Key>(target: Map<Key, number>, entries: Iterable<readonly [Key, number]>): void {
	for (const [key, count] of entries) {
		target.set(key, (target.get(key) ?? 0) + count)
	}
}
