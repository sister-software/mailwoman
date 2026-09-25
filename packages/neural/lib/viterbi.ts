/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

const NEG_INF = -1e9

/**
 * Builds a `numLabels × numLabels` additive log-score mask that permits every transition
 * except entering `I-Y` from anything other than `B-Y` or `I-Y`.
 */
export function buildBIOTransitionMask(labels: readonly string[]): number[][] {
	const n = labels.length
	const mask: number[][] = []

	for (let from = 0; from < n; from++) {
		const row = new Array<number>(n)
		const fromLabel = labels[from]!

		for (let to = 0; to < n; to++) {
			const toLabel = labels[to]!
			row[to] = isValidTransition(fromLabel, toLabel) ? 0 : NEG_INF
		}

		mask.push(row)
	}

	return mask
}

/**
 * Returns the per-label vector of valid start-of-sequence transitions (0 or -inf).
 */
export function buildBIOStartMask(labels: readonly string[]): number[] {
	return labels.map((l) => (l.startsWith("I-") ? NEG_INF : 0))
}

/**
 * Returns an all-zero end-of-sequence mask, since any BIO label is a valid final label.
 */
export function buildBIOEndMask(labels: readonly string[]): number[] {
	return labels.map(() => 0)
}

function isValidTransition(from: string, to: string): boolean {
	if (to === "O") return true

	if (to.startsWith("B-")) return true

	if (to.startsWith("I-")) {
		const tag = to.slice(2)

		return from === `B-${tag}` || from === `I-${tag}`
	}

	return true
}

interface ViterbiTransitionAdjustment {
	timestep: number

	toLabel: number

	bonus: number
}

/**
 * The scores that {@link viterbi} decodes: emissions, transitions, and optional start,
 * end and per-timestep bonuses.
 */
export interface ViterbiInput {
	/**
	 * The log-emission score `emissions[t][k]` for label `k` at timestep `t`,
	 * as raw logits or log-softmax values.
	 */
	emissions: number[][]

	/**
	 * The additive log-score `transitions[from][to]`, such as the mask from {@link buildBIOTransitionMask}.
	 */
	transitions: number[][]

	/**
	 * The per-label log-score for starting the sequence, defaulting to zeros.
	 */
	startTransitions?: number[]

	/**
	 * The per-label log-score for ending the sequence, defaulting to zeros.
	 */
	endTransitions?: number[]

	/**
	 * Bonuses added to the transition into one label at one timestep.
	 *
	 * When several adjustments target the same timestep and label, only the largest bonus applies.
	 */
	transitionAdjustments?: ReadonlyArray<ViterbiTransitionAdjustment>
}

/**
 * The highest-scoring label-index path and its total score.
 */
export interface ViterbiResult {
	/**
	 * The best label index at each timestep.
	 */
	path: number[]

	/**
	 * The total log-score of the path.
	 */
	score: number
}

/**
 * Finds the highest-scoring label sequence under the CRF emissions
 * and transitions in O(seqLen × numLabels²) time.
 */
export function viterbi(input: ViterbiInput): ViterbiResult {
	const { emissions, transitions } = input
	const T = emissions.length

	if (T === 0) return { path: [], score: 0 }

	const numLabels = emissions[0]!.length
	const startTrans = input.startTransitions ?? new Array<number>(numLabels).fill(0)
	const endTrans = input.endTransitions ?? new Array<number>(numLabels).fill(0)

	let adjustAt: Map<number, Map<number, number>> | null = null

	if (input.transitionAdjustments?.length) {
		adjustAt = new Map()

		for (const adj of input.transitionAdjustments) {
			let byLabel = adjustAt.get(adj.timestep)

			if (!byLabel) {
				byLabel = new Map()
				adjustAt.set(adj.timestep, byLabel)
			}

			byLabel.set(adj.toLabel, Math.max(byLabel.get(adj.toLabel) ?? NEG_INF, adj.bonus))
		}
	}

	const dp: number[][] = []
	const back: number[][] = []

	const firstAdjust = adjustAt?.get(0)
	const first = new Array<number>(numLabels)

	for (let k = 0; k < numLabels; k++) {
		first[k] = startTrans[k]! + (firstAdjust?.get(k) ?? 0) + emissions[0]![k]!
	}

	dp.push(first)
	back.push(new Array<number>(numLabels).fill(-1))

	for (let t = 1; t < T; t++) {
		const cur = new Array<number>(numLabels)
		const ptr = new Array<number>(numLabels)
		const tAdjust = adjustAt?.get(t)

		for (let k = 0; k < numLabels; k++) {
			let bestScore = NEG_INF
			let bestPrev = 0

			for (let j = 0; j < numLabels; j++) {
				const s = dp[t - 1]![j]! + transitions[j]![k]!

				if (s > bestScore) {
					bestScore = s
					bestPrev = j
				}
			}

			cur[k] = bestScore + (tAdjust?.get(k) ?? 0) + emissions[t]![k]!
			ptr[k] = bestPrev
		}

		dp.push(cur)
		back.push(ptr)
	}

	let bestEndScore = NEG_INF
	let bestEnd = 0

	for (let k = 0; k < numLabels; k++) {
		const s = dp[T - 1]![k]! + endTrans[k]!

		if (s > bestEndScore) {
			bestEndScore = s
			bestEnd = k
		}
	}

	const path = new Array<number>(T)
	path[T - 1] = bestEnd

	for (let t = T - 1; t > 0; t--) {
		path[t - 1] = back[t]![path[t]!]!
	}

	return { path, score: bestEndScore }
}

/**
 * Picks the highest-scoring label for each token independently, ignoring transitions.
 */
export function perTokenArgmax(emissions: readonly number[][]): number[] {
	return emissions.map((row) => {
		let bestIdx = 0
		let bestVal = row[0]!

		for (let k = 1; k < row.length; k++) {
			if (row[k]! > bestVal) {
				bestVal = row[k]!
				bestIdx = k
			}
		}

		return bestIdx
	})
}

/**
 * Returns the winning label index of one logit row and its softmax probability
 * without materializing the full distribution.
 */
export function argmaxWithConfidence(row: number[]): { idx: number; conf: number } {
	let maxIdx = 0
	let maxVal = row[0]!

	for (let i = 1; i < row.length; i++) {
		if (row[i]! > maxVal) {
			maxVal = row[i]!
			maxIdx = i
		}
	}

	let sumExp = 0

	for (const v of row) {
		sumExp += Math.exp(v - maxVal)
	}

	const conf = 1 / sumExp

	return { idx: maxIdx, conf }
}

/**
 * Converts a logit row to probabilities that sum to 1, subtracting the maximum
 * first for numerical stability.
 */
export function softmax(row: readonly number[]): number[] {
	let max = row[0]!

	for (let i = 1; i < row.length; i++)
		if (row[i]! > max) {
			max = row[i]!
		}

	const exps = row.map((v) => Math.exp(v - max))
	const sum = exps.reduce((a, b) => a + b, 0)

	return exps.map((e) => e / sum)
}
