/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #727 stage-2 Phase 3 — the k-best semi-Markov segment decode, JS side.
 *
 *   The counterpart to `corpus-python`'s `SemiMarkovCRF.decode`: the model scores every span up to
 *   `maxSpan` tokens per segment type (the `span_scores` ONNX output), a segment-level transition
 *   table carries the address grammar, and this decodes whole SEGMENTATIONS — scoring "these k tokens
 *   are ONE street" as a single decision rather than letting it emerge from independent token votes.
 *
 *   Deliberately OUTSIDE the ONNX graph (the Phase-2 design): span enumeration + this DP need dynamic
 *   shapes, which the graph can't express cheaply and the browser shouldn't pay for. Fetching the
 *   scores costs ~0.75ms (CPU, S=128); this decode runs over the pruned candidate set.
 *
 *   K-BEST, not 1-best, from day one: the whole point of the arc is a LIST of hypotheses with
 *   comparable scores for the resolver to rerank (a rank-2 parse that resolves to a real place beats
 *   a rank-1 that resolves to a country centroid). Scores within one input share the partition
 *   function, so they are directly comparable; ACROSS inputs they are not (that needs the Phase-4
 *   isotonic pass).
 *
 *   The segment-type axis is NEVER hardcoded here — it arrives from the weights bundle's
 *   `semi-crf-transitions.json` (the PLACETYPE_ORDER dual-maintenance class: a retrained head that
 *   reorders types would otherwise silently mislabel every decode).
 */

/** The decode-time transition grammar, as shipped in `semi-crf-transitions.json`. */
export interface SemiCRFTransitions {
	/** Segment-type axis, index-aligned with the `span_scores` inner dim. Index 0 is always `O`. */
	segmentTypes: string[]
	/** Max span length in tokens — the `L` axis of `span_scores`. */
	maxSpan: number
	/** `transitions[from][to]` — additive score for a `from`→`to` segment-type transition. */
	transitions: number[][]
	/** `startTransitions[t]` — additive score for a segmentation whose FIRST segment is type `t`. */
	startTransitions: number[]
	/** `endTransitions[t]` — additive score for a segmentation whose LAST segment is type `t`. */
	endTransitions: number[]
}

/** One decoded segment: tokens `[start, start + length)` carry type `segmentTypes[typeID]`. */
export interface DecodedSegment {
	start: number
	length: number
	typeID: number
}

/** One whole-segmentation hypothesis. `score` is comparable to its siblings from the SAME input. */
export interface SegmentationHypothesis {
	score: number
	segments: DecodedSegment[]
}

/**
 * Finite sentinel rather than -Infinity: an all-masked row would otherwise produce -inf - (-inf) = NaN. Mirrors
 * `_NEG_INF` in `corpus-python/src/mailwoman_train/span_scorer.py` (the v0.5.0 bf16 CRF NaN scar — do not hand this
 * arithmetic an opportunity).
 */
const NEG_INF = -1e4

/** `O` is index 0 by construction (`_derive_segment_types` in span_scorer.py). */
const O_TYPE_ID = 0

/**
 * Parse the `semi-crf-transitions.json` sidecar. Throws on a shape mismatch rather than decoding with a half-valid
 * grammar — a silently-wrong transition table trains nothing but corrupts every decode.
 */
export function parseSemiCRFTransitions(raw: unknown): SemiCRFTransitions {
	const o = raw as Record<string, unknown>
	const segmentTypes = o["segment_types"] as string[] | undefined
	const transitions = o["transitions"] as number[][] | undefined
	const startTransitions = o["start_transitions"] as number[] | undefined
	const endTransitions = o["end_transitions"] as number[] | undefined
	const maxSpan = o["max_span"] as number | undefined

	if (!segmentTypes?.length || !transitions?.length || !startTransitions?.length || !endTransitions?.length) {
		throw new Error("semi-crf-transitions: missing segment_types / transitions / start_transitions / end_transitions")
	}

	if (typeof maxSpan !== "number" || maxSpan < 1) {
		throw new Error(`semi-crf-transitions: max_span must be a positive number, got ${String(maxSpan)}`)
	}
	const n = segmentTypes.length

	if (transitions.length !== n || transitions.some((row) => row.length !== n)) {
		throw new Error(`semi-crf-transitions: transitions must be ${n}x${n} to match segment_types`)
	}

	if (startTransitions.length !== n || endTransitions.length !== n) {
		throw new Error(`semi-crf-transitions: start/end transitions must have length ${n}`)
	}

	if (segmentTypes[0] !== "O") {
		throw new Error(`semi-crf-transitions: segment_types[0] must be "O", got ${String(segmentTypes[0])}`)
	}

	return { segmentTypes, maxSpan, transitions, startTransitions, endTransitions }
}

/**
 * K-best semi-Markov decode over `spanScores`.
 *
 * `spanScores[i][l][t]` scores the segment starting at token `i`, of length `l + 1`, typed `t` — the exact layout of
 * the `span_scores` ONNX output. `O` segments are length 1 by construction (every non-entity token is its own `O`),
 * which keeps the state space small and matches the training-side DP that produced the scores.
 *
 * State = (token index, last non-O segment type); the top-`k` paths are kept per state. Returns up to `k` complete
 * segmentations, best first. Every returned segmentation covers `[0, seqLen)` exactly — no gaps, no overlaps.
 */
export function decodeSegmentationsKBest(
	spanScores: number[][][],
	seqLen: number,
	grammar: SemiCRFTransitions,
	k = 1
): SegmentationHypothesis[] {
	const numTypes = grammar.segmentTypes.length
	const maxSpan = Math.min(grammar.maxSpan, spanScores[0]?.length ?? 0)

	// dp[j] : lastType -> up-to-k best partial segmentations covering [0, j).
	const dp: Array<Map<number, SegmentationHypothesis[]>> = Array.from({ length: seqLen + 1 }, () => new Map())
	// -1 is the BOS pseudo-type; startTransitions carries its outgoing scores.
	dp[0]!.set(-1, [{ score: 0, segments: [] }])

	const push = (column: Map<number, SegmentationHypothesis[]>, key: number, entry: SegmentationHypothesis): void => {
		const list = column.get(key)

		if (!list) {
			column.set(key, [entry])

			return
		}
		// Insertion sort into a k-bounded, descending list — cheaper than sort() per push at k ≤ 10.
		let i = list.length

		while (i > 0 && list[i - 1]!.score < entry.score) {
			i--
		}

		if (i >= k) return
		list.splice(i, 0, entry)

		if (list.length > k) {
			list.length = k
		}
	}

	for (let j = 1; j <= seqLen; j++) {
		for (let spanLen = 1; spanLen <= Math.min(maxSpan, j); spanLen++) {
			const i = j - spanLen
			const perLength = spanScores[i]?.[spanLen - 1]

			if (!perLength) continue

			for (const [lastType, entries] of dp[i]!) {
				for (const entry of entries) {
					for (let t = 0; t < numTypes; t++) {
						// O segments are length 1 by construction.
						if (t === O_TYPE_ID && spanLen !== 1) continue
						const segScore = perLength[t] ?? NEG_INF
						const trans = lastType === -1 ? grammar.startTransitions[t]! : grammar.transitions[lastType]![t]!
						push(dp[j]!, t, {
							score: entry.score + segScore + trans,
							segments: [...entry.segments, { start: i, length: spanLen, typeID: t }],
						})
					}
				}
			}
		}
	}

	const finals: SegmentationHypothesis[] = []

	for (const [lastType, entries] of dp[seqLen]!) {
		if (lastType === -1) continue

		// an empty segmentation is not a reading

		for (const entry of entries) {
			finals.push({ score: entry.score + grammar.endTransitions[lastType]!, segments: entry.segments })
		}
	}
	finals.sort((a, b) => b.score - a.score)

	return finals.slice(0, k)
}
