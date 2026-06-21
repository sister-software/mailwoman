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
 *   "entities" silently fracture or fuse.
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
	/**
	 * How the above-threshold link graph resolves into clusters:
	 *
	 * - `"single"` (default) — connected components (union-find). Fast; ANY above-threshold link fuses
	 *   two groups, so a single weak link can over-merge unrelated records through a transitive
	 *   chain.
	 * - `"average"` — agglomerative average-linkage refinement WITHIN each connected component: two
	 *   sub-clusters merge only when the AVERAGE weight of the links between them clears the
	 *   threshold, so a lone weak bridge no longer fuses two otherwise-dense groups. The documented
	 *   over-merge fix (Dedupe). Falls back to single-linkage for any component larger than
	 *   {@link maxAverageLinkageComponent}.
	 */
	linkage?: "single" | "average"
	/**
	 * Components larger than this skip the O(k³) average-linkage refine and keep single-linkage.
	 * Default 64.
	 */
	maxAverageLinkageComponent?: number
}

/**
 * Refine one connected component by agglomerative average-linkage. Starts with every member a
 * singleton and repeatedly merges the cluster pair with the highest _average_ inter-cluster link
 * weight while that average is at or above `threshold`; clusters with no link between them never
 * merge. O(k³) in the component size, so callers gate it on a size cap.
 */
function averageLinkageRefine<R>(members: R[], edges: Array<[number, number, number]>, threshold: number): R[][] {
	const clusters = members.map((_, i) => [i])
	const crossAverage = (a: number[], b: number[]): number | null => {
		const inA = new Set(a)
		const inB = new Set(b)
		let sum = 0
		let count = 0
		for (const [i, j, w] of edges) {
			if ((inA.has(i) && inB.has(j)) || (inA.has(j) && inB.has(i))) {
				sum += w
				count++
			}
		}
		return count > 0 ? sum / count : null
	}

	for (;;) {
		let bestAvg = -Infinity
		let bestPair: [number, number] | null = null
		for (let p = 0; p < clusters.length; p++) {
			for (let q = p + 1; q < clusters.length; q++) {
				const avg = crossAverage(clusters[p]!, clusters[q]!)
				if (avg !== null && avg > bestAvg) {
					bestAvg = avg
					bestPair = [p, q]
				}
			}
		}
		if (!bestPair || bestAvg < threshold) break
		const [p, q] = bestPair
		clusters[p] = clusters[p]!.concat(clusters[q]!)
		clusters.splice(q, 1)
	}

	return clusters.map((local) => local.map((i) => members[i]!))
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

	// Collect ALL valid links (not just above-threshold): connected components form from the
	// above-threshold ones, but the average-linkage refinement needs the full sub-graph — a weak or
	// disagreeing below-threshold edge between two sub-clusters is exactly what should pull them apart.
	const allLinks: ScoredLink<R>[] = []
	for (const link of links) {
		const ia = index.get(link.a)
		const ib = index.get(link.b)
		if (ia === undefined || ib === undefined) continue
		allLinks.push(link)
		if (link.weight >= opts.threshold) union(ia, ib)
	}

	const groups = new Map<number, R[]>()
	records.forEach((record, i) => {
		const root = find(i)
		const group = groups.get(root)
		if (group) group.push(record)
		else groups.set(root, [record])
	})

	if (opts.linkage !== "average") return [...groups.values()]

	// Average-linkage refinement: split each component where its sub-clusters are joined only by a weak
	// bridge (the average inter-cluster link weight, over ALL edges between them, falls below the threshold).
	const maxComponent = opts.maxAverageLinkageComponent ?? 64
	const localOf = new Map<R, number>() // member → its index within its own group
	for (const members of groups.values()) members.forEach((m, i) => localOf.set(m, i))
	const groupEdges = new Map<number, Array<[number, number, number]>>()
	for (const link of allLinks) {
		const root = find(index.get(link.a)!)
		if (root !== find(index.get(link.b)!)) continue // cross-component edge — not part of any refinement
		const list = groupEdges.get(root) ?? []
		list.push([localOf.get(link.a)!, localOf.get(link.b)!, link.weight])
		groupEdges.set(root, list)
	}

	const result: R[][] = []
	for (const [root, members] of groups) {
		if (members.length <= 1 || members.length > maxComponent) {
			result.push(members)
			continue
		}
		for (const sub of averageLinkageRefine(members, groupEdges.get(root) ?? [], opts.threshold)) result.push(sub)
	}
	return result
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
