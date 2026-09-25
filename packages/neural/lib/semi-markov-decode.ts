/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The decode-time transition grammar, as shipped in `semi-crf-transitions.json`.
 */
export interface SemiCRFTransitions {
	/**
	 * The segment types, index-aligned with the type axis of `span_scores`; index 0 must be `O`.
	 */
	segmentTypes: string[]

	/**
	 * The maximum span length in tokens, which is the length axis of `span_scores`.
	 */
	maxSpan: number

	/**
	 * The additive score for a segment of type `from` followed by one of type `to`,
	 * indexed as `transitions[from][to]`.
	 */
	transitions: number[][]

	/**
	 * The additive score for a segmentation whose first segment has each type.
	 */
	startTransitions: number[]

	/**
	 * The additive score for a segmentation whose last segment has each type.
	 */
	endTransitions: number[]
}

/**
 * One decoded segment: tokens `[start, start + length)` carry type `segmentTypes[typeID]`.
 */
export interface DecodedSegment {
	start: number
	length: number
	typeID: number
}

/**
 * One complete segmentation of the input and its score, which is comparable only
 * with other hypotheses decoded from the same input.
 */
export interface SegmentationHypothesis {
	score: number
	segments: DecodedSegment[]
}

const NEG_INF = -1e4

const O_TYPE_ID = 0

/**
 * Parses and validates the `semi-crf-transitions.json` sidecar into a decode grammar.
 *
 * @throws On any shape mismatch, because a half-valid transition table would silently corrupt every decode.
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
 * Returns up to `k` best segmentations of `[0, seqLen)` from the `span_scores`
 * model output, each covering every token exactly once.
 *
 * `spanScores[i][l][t]` scores a segment of type `t` starting at token `i` with length
 * `l + 1`, and `O` segments are always one token long, matching training.
 */
export function decodeSegmentationsKBest(
	spanScores: number[][][],
	seqLen: number,
	grammar: SemiCRFTransitions,
	k = 1
): SegmentationHypothesis[] {
	const numTypes = grammar.segmentTypes.length
	const maxSpan = Math.min(grammar.maxSpan, spanScores[0]?.length ?? 0)

	const dp: Array<Map<number, SegmentationHypothesis[]>> = Array.from({ length: seqLen + 1 }, () => new Map())

	dp[0]!.set(-1, [{ score: 0, segments: [] }])

	const push = (column: Map<number, SegmentationHypothesis[]>, key: number, entry: SegmentationHypothesis): void => {
		const list = column.get(key)

		if (!list) {
			column.set(key, [entry])

			return
		}

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

			const extend = (lastType: number, entry: SegmentationHypothesis): void => {
				for (let t = 0; t < numTypes; t++) {
					if (t === O_TYPE_ID && spanLen !== 1) continue
					const segScore = perLength[t] ?? NEG_INF
					const trans = lastType === -1 ? grammar.startTransitions[t]! : grammar.transitions[lastType]![t]!

					push(dp[j]!, t, {
						score: entry.score + segScore + trans,
						segments: [...entry.segments, { start: i, length: spanLen, typeID: t }],
					})
				}
			}

			for (const [lastType, entries] of dp[i]!) {
				for (const entry of entries) {
					extend(lastType, entry)
				}
			}
		}
	}

	const finals: SegmentationHypothesis[] = []

	for (const [lastType, entries] of dp[seqLen]!) {
		if (lastType === -1) continue

		for (const entry of entries) {
			finals.push({ score: entry.score + grammar.endTransitions[lastType]!, segments: entry.segments })
		}
	}

	finals.sort((a, b) => b.score - a.score)

	return finals.slice(0, k)
}
