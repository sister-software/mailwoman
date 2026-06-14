/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clustering — the third and final matcher stage: resolve scored pairs into canonical entities.
 *
 *   The pairwise scorer treats each pair independently, and its scores are NOT transitive: A~B at a
 *   high weight and B~C at a high weight does not guarantee A~C is a match. So a distinct stage is
 *   required to turn the graph of above-threshold links into coherent groups — skip it and your
 *   "entities" quietly fracture or fuse.
 *
 *   This ships the standard baseline: connected components of the link graph (union-find), with the
 *   link threshold as the precision/recall knob — raise it for tighter, purer clusters, lower it
 *   for more recall. Its known weakness is over-merging via transitive chains (a string of weak
 *   links can pull unrelated records into one component); the principled fix is
 *   centroid-/average-linkage hierarchical clustering (Dedupe), which uses the full within-cluster
 *   score matrix — a documented refinement, not this first cut. For a geocode-first matcher the
 *   over-merge risk is already damped: blocking keeps candidate sets local, so chains can't run
 *   across the whole dataset.
 */

/** A scored candidate pair: two records and the match weight (bits) the scorer assigned them. */
export interface ScoredLink<R> {
	a: R
	b: R
	weight: number
}

/** Options for {@link cluster}. */
export interface ClusterOptions {
	/**
	 * Link two records only when their match weight is at or above this (bits) — the precision/recall
	 * knob.
	 */
	threshold: number
}

/**
 * Cluster records into canonical entities by connected components of the above-threshold link
 * graph. Every input record lands in exactly one cluster — a record with no qualifying link is a
 * singleton. Links referencing a record not in `records` are ignored. Reference identity is used,
 * so pass the same record objects to both arguments.
 */
export function cluster<R>(records: readonly R[], links: Iterable<ScoredLink<R>>, opts: ClusterOptions): R[][] {
	const index = new Map<R, number>()
	records.forEach((record, i) => index.set(record, i))

	const parent = records.map((_, i) => i)
	const rank = new Array<number>(records.length).fill(0)

	const find = (x: number): number => {
		let root = x
		while (parent[root] !== root) root = parent[root]!
		// Path compression.
		while (parent[x] !== root) {
			const next = parent[x]!
			parent[x] = root
			x = next
		}
		return root
	}

	const union = (x: number, y: number): void => {
		const rx = find(x)
		const ry = find(y)
		if (rx === ry) return
		if (rank[rx]! < rank[ry]!) parent[rx] = ry
		else if (rank[rx]! > rank[ry]!) parent[ry] = rx
		else {
			parent[ry] = rx
			rank[rx]!++
		}
	}

	for (const link of links) {
		if (link.weight < opts.threshold) continue
		const ia = index.get(link.a)
		const ib = index.get(link.b)
		if (ia === undefined || ib === undefined) continue
		union(ia, ib)
	}

	const groups = new Map<number, R[]>()
	records.forEach((record, i) => {
		const root = find(i)
		const group = groups.get(root)
		if (group) group.push(record)
		else groups.set(root, [record])
	})

	return [...groups.values()]
}

/**
 * Pick a cluster's most complete record as its canonical representative — the one with the fewest
 * empty fields (`null` / `undefined` / `""`). Ties keep the earliest. A basic, generic
 * canonicalizer; field-level merging across the cluster is the application's job (it knows which
 * source to trust).
 */
export function representative<R extends object>(group: readonly R[]): R | undefined {
	let best: R | undefined
	let bestFilled = -1

	for (const record of group) {
		let filled = 0
		for (const value of Object.values(record)) {
			if (value !== null && value !== undefined && value !== "") filled++
		}
		if (filled > bestFilled) {
			bestFilled = filled
			best = record
		}
	}

	return best
}
