/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Blocking — candidate generation. Comparing every pair is O(n²) (a million records is a trillion
 *   comparisons), so we only score pairs that share a cheap key. This is where the geocode-first
 *   bet pays off: two records resolving to the same place land in the same spatial cell regardless
 *   of how their address strings are spelled, so geography is the primary block.
 *
 *   A {@link BlockingKey} maps a record to zero or more string keys; records sharing any key become
 *   candidates. Keys compose as a _union_ (the standard multi-pass approach — high recall from
 *   cheap rules): block on the spatial cell OR the canonical key OR the postcode, and a pair that
 *   any rule catches is scored. {@link conjunction} builds the AND-style key Geo-ER uses (`name-cell
 *   AND geo-cell`) when a single rule is too loose.
 *
 *   Recall is the priority — a pair the blocker never proposes can never match, the most dangerous
 *   silent failure in record linkage. So the spatial grid is generous and neighbour-expanded by
 *   default, and any block too large to scan is _reported_, never silently dropped.
 */

/** Maps a record to zero or more block keys. Two records sharing any key become a candidate pair. */
export type BlockingKey<R> = (record: R) => string[]

/** A geographic coordinate (WGS84 decimal degrees). */
export interface LatLon {
	latitude: number
	longitude: number
}

/**
 * A spatial-cell block key: a configurable lat/lon grid. `precisionDegrees` sets the cell size (default 0.05° ≈ 5.5 km
 * of latitude — deliberately generous, per the literature, so same-place records reliably co-block). With `neighbors`
 * (default `true`) a record also keys its 8 adjacent cells, so a pair straddling a cell boundary still meets.
 *
 * Note: an equal-_degree_ grid (longitude cells shrink toward the poles) and neighbour expansion inflates block sizes
 * ~9×; an equal-area H3/geohash index with a single-cell + neighbour-query is the refinement. Behaviour — proximity
 * co-blocking — is the same.
 */
export function geoCellKey<R>(
	extract: (record: R) => LatLon | null | undefined,
	opts: { precisionDegrees?: number; neighbors?: boolean } = {}
): BlockingKey<R> {
	const step = opts.precisionDegrees ?? 0.05
	const expand = opts.neighbors ?? true

	return (record) => {
		const coordinate = extract(record)

		if (!coordinate || !Number.isFinite(coordinate.latitude) || !Number.isFinite(coordinate.longitude)) return []

		const latCell = Math.floor(coordinate.latitude / step)
		const lonCell = Math.floor(coordinate.longitude / step)

		if (!expand) return [`${latCell}:${lonCell}`]

		const keys: string[] = []

		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				keys.push(`${latCell + dLat}:${lonCell + dLon}`)
			}
		}

		return keys
	}
}

/**
 * An exact-value block key (the canonical address key, a postcode, an email domain…), normalized and optionally
 * truncated to a leading `prefix` of characters (a cheaper, higher-recall rule). A missing or empty value produces no
 * key.
 */
export function exactKey<R>(
	extract: (record: R) => string | null | undefined,
	opts: { prefix?: number; normalize?: (value: string) => string } = {}
): BlockingKey<R> {
	const normalize = opts.normalize ?? ((v: string) => v.trim().toLowerCase().replace(/\s+/g, " "))

	return (record) => {
		const value = extract(record)

		if (!value) return []
		const normalized = normalize(value)

		if (!normalized) return []

		return [opts.prefix ? normalized.slice(0, opts.prefix) : normalized]
	}
}

/**
 * A conjunctive block key — the cross-product of its sub-keys, joined (Geo-ER's "name AND distance"). A record is keyed
 * by every combination of one sub-key from each input, so two records co-block only when they agree on _all_ inputs.
 * Tighter blocks, lower recall — use when a single rule is too loose.
 */
export function conjunction<R>(...keys: BlockingKey<R>[]): BlockingKey<R> {
	return (record) => {
		let combos = [""]

		for (const key of keys) {
			const parts = key(record)

			if (parts.length === 0) return []
			combos = combos.flatMap((prefix) => parts.map((part) => (prefix ? `${prefix}&${part}` : part)))
		}

		return combos
	}
}

/** The outcome of a blocking pass. */
export interface BlockResult<R> {
	/** Deduplicated candidate pairs (no self-pairs; a pair caught by multiple keys appears once). */
	pairs: Array<[R, R]>
	/** Blocks that exceeded `maxBlockSize` and were skipped — surfaced so coverage limits are visible. */
	droppedBlocks: Array<{ key: string; size: number }>
}

/**
 * Generate candidate pairs from `records` via one or more blocking keys (their union). Builds an inverted index (key →
 * records) and emits the unique within-block pairs. A block larger than `maxBlockSize` is skipped and reported in
 * `droppedBlocks` rather than blowing up into a quadratic scan — an explicit, visible coverage limit, not a silent
 * drop.
 */
export function block<R>(
	records: readonly R[],
	blockingKeys: BlockingKey<R> | BlockingKey<R>[],
	opts: { maxBlockSize?: number } = {}
): BlockResult<R> {
	const keys = Array.isArray(blockingKeys) ? blockingKeys : [blockingKeys]
	const maxBlockSize = opts.maxBlockSize ?? Infinity
	const index = new Map<string, number[]>()

	records.forEach((record, i) => {
		const seen = new Set<string>()

		for (const keyFn of keys) {
			for (const key of keyFn(record)) {
				if (!key || seen.has(key)) continue
				seen.add(key)
				const bucket = index.get(key)

				if (bucket) bucket.push(i)
				else index.set(key, [i])
			}
		}
	})

	const n = records.length
	const emitted = new Set<number>()
	const pairs: Array<[R, R]> = []
	const droppedBlocks: BlockResult<R>["droppedBlocks"] = []

	for (const [key, bucket] of index) {
		if (bucket.length < 2) continue

		if (bucket.length > maxBlockSize) {
			droppedBlocks.push({ key, size: bucket.length })
			continue
		}

		for (let a = 0; a < bucket.length; a++) {
			for (let b = a + 1; b < bucket.length; b++) {
				const lo = Math.min(bucket[a]!, bucket[b]!)
				const hi = Math.max(bucket[a]!, bucket[b]!)
				const id = lo * n + hi

				if (emitted.has(id)) continue
				emitted.add(id)
				pairs.push([records[lo]!, records[hi]!])
			}
		}
	}

	return { pairs, droppedBlocks }
}
