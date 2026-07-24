/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Linear-chain CRF Viterbi decoder in TypeScript.
 *
 *   Replaces per-token argmax in the classifier when transition scores are available. Mirrors the
 *   Python training-time / eval-time path so JS runtime decode agrees with the model card's
 *   metrics.
 *
 *   Two transition matrix modes:
 *
 *   1. **Structural-only** (no weights changes required) — build from the BIO label vocabulary using
 *        `buildBIOTransitionMask()`. Forbids `O → I-X`, `B-X → I-Y` (X ≠ Y), and sequence-start →
 *        `I-X`. Permits everything else. This alone prevents orphan-I decoding ("Saint Petersburg →
 *        Petersburg" bug) at runtime — a strict improvement over argmax.
 *   2. **Learned** (requires a future weights release that ships `crf-transitions.json`) — load the
 *        trained transition matrix from the model card. Adds learned soft priors on top of the
 *        structural mask. Currently not exported from the training-side ONNX bundle.
 */

const NEG_INF = -1e9

/**
 * Build the BIO structural transition mask given the label vocabulary in order.
 *
 * Rules:
 *
 * - `X → O` always permitted (0)
 * - `X → B-Y` always permitted (0)
 * - `X → I-Y` permitted only if `X` is `B-Y` or `I-Y` (0); otherwise -inf
 *
 * Returns a `numLabels × numLabels` matrix where `mask[from][to]` is the additive log-score (0 for permitted, NEG_INF
 * for forbidden).
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

/** Returns the per-label vector of valid start-of-sequence transitions (0 or -inf). */
export function buildBIOStartMask(labels: readonly string[]): number[] {
	return labels.map((l) => (l.startsWith("I-") ? NEG_INF : 0))
}

/**
 * End-of-sequence transitions. By default all labels are valid endings (returns zeros). Override if the trained model
 * has learned end transitions.
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

/**
 * A position-scoped transition bonus (TRANSITION-BETA build, 2026-07-24): `+bonus` on every transition INTO `toLabel`
 * at exactly `timestep` — from ANY predecessor label (at `timestep === 0` the "predecessor" is the sequence start, so
 * the bonus lands on the start transition instead). The placetype-pair prior emits one per pair hit at the child span's
 * first piece when its index header carries `transitionBeta`; the hook itself is generic — a sparse list of
 * adjustments, no knowledge of who produced them.
 *
 * Because the bonus is predecessor-independent, it cannot change WHICH predecessor wins for `toLabel` at `timestep` —
 * it changes whether paths ENTERING `toLabel` there outscore paths that stay fused through a competing run (the task-8
 * probe's path-fusion mechanism: a locally-winning emission bias can still lose globally when the forced
 * `I-`/fresh-`B-` continuation costs more than the local win recovers; a transition-entry bonus pays that structural
 * toll directly).
 */
export interface ViterbiTransitionAdjustment {
	/** Timestep whose INCOMING transition is adjusted. */
	timestep: number
	/** Label index (into the emission row / transition matrix axes) the adjusted transition lands on. */
	toLabel: number
	/** Additive bonus (log-score units, like the transition matrix itself). */
	bonus: number
}

export interface ViterbiInput {
	/** `emissions[t][k]` — log-emission for label k at timestep t. Pass raw logits or log-softmaxes. */
	emissions: number[][]
	/** `transitions[from][to]` — additive log-score. Use `buildBIOTransitionMask` if unsure. */
	transitions: number[][]
	/** Per-label log-score for being the FIRST label. */
	startTransitions?: number[]
	/** Per-label log-score for being the LAST label. */
	endTransitions?: number[]
	/**
	 * Position-scoped transition bonuses (see {@link ViterbiTransitionAdjustment}). Omitted/empty = the exact
	 * pre-TRANSITION-BETA decode — no behavioral term is added anywhere.
	 */
	transitionAdjustments?: ReadonlyArray<ViterbiTransitionAdjustment>
}

export interface ViterbiResult {
	/** Best label index per timestep. */
	path: number[]
	/** Total path score (log-prob). */
	score: number
}

/**
 * Viterbi decode: find the highest-scoring label sequence under the CRF.
 *
 * Time: O(seq_len × num_labels²). Space: O(seq_len × num_labels) for the backpointer table.
 */
export function viterbi(input: ViterbiInput): ViterbiResult {
	const { emissions, transitions } = input
	const T = emissions.length

	if (T === 0) return { path: [], score: 0 }

	const numLabels = emissions[0]!.length
	const startTrans = input.startTransitions ?? new Array<number>(numLabels).fill(0)
	const endTrans = input.endTransitions ?? new Array<number>(numLabels).fill(0)

	// Sparse per-timestep lookup for the position-scoped transition bonuses. Null when none were
	// passed — the hot loop below then never consults it (the pre-TRANSITION-BETA code path, exactly).
	let adjustAt: Map<number, Map<number, number>> | null = null

	if (input.transitionAdjustments?.length) {
		adjustAt = new Map()

		for (const adj of input.transitionAdjustments) {
			let byLabel = adjustAt.get(adj.timestep)

			if (!byLabel) {
				byLabel = new Map()
				adjustAt.set(adj.timestep, byLabel)
			}
			// Two adjustments landing on the same (timestep, toLabel) cell compose by MAX, not sum — the
			// emission side's `applyWindowBias` uses the same Math.max discipline, and overlapping window-mode
			// candidates must not stack the bonus.
			byLabel.set(adj.toLabel, Math.max(byLabel.get(adj.toLabel) ?? NEG_INF, adj.bonus))
		}
	}

	// dp[t][k] = best log-score ending at (timestep t, label k)
	const dp: number[][] = []
	const back: number[][] = []

	// t = 0 — an adjustment at timestep 0 lands on the start transition (the sequence start is the
	// only "predecessor" a first label has).
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
			// The bonus is predecessor-independent, so it distributes over the max — adding it AFTER the
			// argmax over j is exact, not an approximation.
			cur[k] = bestScore + (tAdjust?.get(k) ?? 0) + emissions[t]![k]!
			ptr[k] = bestPrev
		}
		dp.push(cur)
		back.push(ptr)
	}

	// Pick the best ending state.
	let bestEndScore = NEG_INF
	let bestEnd = 0

	for (let k = 0; k < numLabels; k++) {
		const s = dp[T - 1]![k]! + endTrans[k]!

		if (s > bestEndScore) {
			bestEndScore = s
			bestEnd = k
		}
	}

	// Trace back.
	const path = new Array<number>(T)
	path[T - 1] = bestEnd

	for (let t = T - 1; t > 0; t--) {
		path[t - 1] = back[t]![path[t]!]!
	}

	return { path, score: bestEndScore }
}

/**
 * Convenience: argmax over per-token softmax (existing behavior). Provided so callers can opt in to Viterbi only when
 * transitions are available, falling back to this cleanly.
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
 * Softmax of a logit row (returns probabilities summing to 1).
 *
 * Used to compute per-token confidence after Viterbi picks the label sequence — the confidence is the softmax
 * probability of the Viterbi-chosen label at that timestep.
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
