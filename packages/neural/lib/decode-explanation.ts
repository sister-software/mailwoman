/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Explains a decode by the terms of the objective the decoder maximized: for each decoded span, the
 *   best reading that labels the span differently and the score difference term by term, and for each
 *   prior, what it added to the decoded reading and which spans it changed.
 */

import { addEmissionMatrix } from "#query-shape-prior"
import { perTokenArgmax, viterbi, viterbiPathTerms, type ViterbiTransitionAdjustment } from "#viterbi"

/**
 * The emission an address-system conventions mask writes into a forbidden label's cell.
 */
const MASKED_EMISSION = -1e9

/**
 * The additive emission priors, in the order the classifier adds them to the logits.
 *
 * The anchor-region boost is part of the `fst` matrix, and the placetype census
 * adds no bias, so neither has a term of its own.
 */
export const EMISSION_PRIOR_TERMS = [
	"queryShape",
	"fst",
	"streetMorphology",
	"spanProposer",
	"venueHead",
	"placetypePair",
] as const

/**
 * One prior from {@linkcode EMISSION_PRIOR_TERMS}.
 */
export type EmissionPriorTerm = (typeof EMISSION_PRIOR_TERMS)[number]

/**
 * Every term the decode objective sums, so a reading's total is the sum of these values.
 *
 * - `logits` is the model's emission before any prior.
 * - Each {@linkcode EMISSION_PRIOR_TERMS} entry is that prior's emission bias.
 * - `placetypePairTransitions` is the placetype-pair prior's per-position transition bonus.
 * - `conventionsMask` is the change the conventions mask makes when it writes `-1e9` over a forbidden label.
 * - `transitions` is the start, pairwise and end transition score: the BIO
 *   structural mask plus any learned transitions.
 *
 * The objective has no phrase-cohesion term (`decoder-grammar.mdx` §1), so none appears here.
 * Under argmax decoding the two transition terms are zero.
 */
export const DECODE_TERMS = [
	"logits",
	...EMISSION_PRIOR_TERMS,
	"placetypePairTransitions",
	"conventionsMask",
	"transitions",
] as const

/**
 * One term from {@linkcode DECODE_TERMS}.
 */
export type DecodeTerm = (typeof DECODE_TERMS)[number]

/**
 * A value for every term of the objective.
 */
export type DecodeTermValues = Record<DecodeTerm, number>

/**
 * A prior a ledger entry can remove: the emission priors, the conventions mask,
 * and the placetype-pair prior with its transition bonuses together.
 */
export type LedgerPrior = EmissionPriorTerm | "conventionsMask"

/**
 * The quantities one decode summed, captured by the classifier as it built them.
 */
export interface DecodeObjective {
	decode: "viterbi" | "argmax"

	/**
	 * The model emissions before any prior.
	 */
	logits: readonly (readonly number[])[]

	/**
	 * Each emission prior the decode added, in the order it added them.
	 */
	emissionPriors: ReadonlyArray<{ term: EmissionPriorTerm; matrix: readonly (readonly number[])[] }>

	/**
	 * The label indices the conventions mask overwrote, null when no mask applied.
	 */
	maskedLabels: ReadonlySet<number> | null

	transitions: number[][]
	startTransitions: number[]
	endTransitions: number[]

	/**
	 * The placetype-pair transition bonuses as indices, null when the prior produced none.
	 */
	transitionAdjustments: ViterbiTransitionAdjustment[] | null
}

/**
 * One piece whose label differs between two readings.
 */
export interface PieceLabelChange {
	piece: number
	text: string
	from: string
	to: string
}

/**
 * A contiguous run of pieces the decoder gave one tag, with the best reading that labels it differently.
 */
export interface DecodeSpanExplanation {
	/**
	 * The span's first piece index and the index one past its last piece.
	 */
	pieceStart: number
	pieceEnd: number

	/**
	 * The span's character offsets in the decoded text.
	 */
	start: number
	end: number
	text: string

	/**
	 * The bare component tag, or `O` for a run of outside pieces.
	 */
	tag: string

	/**
	 * The decoded BIO label of each piece in the span.
	 */
	labels: string[]

	/**
	 * The highest-scoring reading that labels at least one piece of the span differently,
	 * or null when every piece has a single label to choose from.
	 *
	 * The runner-up may relabel pieces outside the span too, and `changes` lists every piece it relabels.
	 */
	runnerUp: {
		labels: string[]
		changes: PieceLabelChange[]
		total: number
	} | null

	/**
	 * The decoded reading's total minus the runner-up's, null without a runner-up.
	 */
	margin: number | null

	/**
	 * The margin split by objective term.
	 * The values sum to `margin`.
	 */
	termMargins: DecodeTermValues | null
}

/**
 * What one prior did to the decode.
 */
export interface PriorLedgerEntry {
	prior: LedgerPrior

	/**
	 * Every nonzero emission change the prior made, by piece and label.
	 */
	cells: Array<{ piece: number; label: string; delta: number }>

	/**
	 * The placetype-pair prior's transition bonuses, empty for every other prior.
	 */
	transitionBonuses: Array<{ piece: number; label: string; bonus: number }>

	/**
	 * What the prior's terms added to the decoded reading's total.
	 */
	decodedPathContribution: number

	/**
	 * The pieces the decoder labels differently when this prior is removed
	 * and every other term kept, with the decoded label as `from`.
	 */
	changes: PieceLabelChange[]

	/**
	 * The indices into {@link DecodeExplanation.spans} of the spans holding a changed piece.
	 */
	changedSpans: number[]

	/**
	 * The objective value, without this prior, of the reading decoded without it.
	 */
	totalWithout: number
}

/**
 * The decode explained in the terms of the objective it maximized.
 */
export interface DecodeExplanation {
	/**
	 * The score the decoder itself computed for its path: the Viterbi score,
	 * or the sum of the chosen emissions under argmax.
	 */
	decoderScore: number

	/**
	 * The decoded reading's total split by objective term.
	 * The values sum to `decoderScore`.
	 */
	decodedTerms: DecodeTermValues
	spans: DecodeSpanExplanation[]

	/**
	 * One entry for each prior that changed an emission or added a transition bonus.
	 */
	ledger: PriorLedgerEntry[]
}

type Matrix = readonly (readonly number[])[]

/**
 * Builds the emission matrix the decoder ran on from the captured quantities,
 * leaving one prior out on request.
 *
 * Each prior is added with the classifier's own `addEmissionMatrix` in the classifier's order,
 * so the full composition reproduces the decoder's matrix bit for bit.
 */
export function composeEmissions(objective: DecodeObjective, without?: LedgerPrior): number[][] {
	let emissions = objective.logits as number[][]

	for (const { term, matrix } of objective.emissionPriors) {
		if (term === without) continue
		emissions = addEmissionMatrix(emissions, matrix as number[][])
	}

	const masked = without === "conventionsMask" ? null : objective.maskedLabels

	if (masked?.size) {
		emissions = emissions.map((row) => row.map((v, idx) => (masked.has(idx) ? MASKED_EMISSION : v)))
	}

	return emissions
}

/**
 * Decodes an emission matrix with the decoder the objective names.
 */
function decodePath(objective: DecodeObjective, emissions: number[][], without?: LedgerPrior): number[] {
	if (objective.decode === "argmax") return perTokenArgmax(emissions)

	const adjustments = without === "placetypePair" ? null : objective.transitionAdjustments

	return viterbi({
		emissions,
		transitions: objective.transitions,
		startTransitions: objective.startTransitions,
		endTransitions: objective.endTransitions,
		...(adjustments ? { transitionAdjustments: adjustments } : {}),
	}).path
}

/**
 * Scores a path under the objective, or under the objective without one prior.
 */
function objectiveTotal(
	objective: DecodeObjective,
	emissions: number[][],
	path: readonly number[],
	without?: LedgerPrior
): number {
	if (objective.decode === "argmax") return path.reduce((sum, label, t) => sum + emissions[t]![label]!, 0)

	const adjustments = without === "placetypePair" ? null : objective.transitionAdjustments

	const parts = viterbiPathTerms(
		{
			emissions,
			transitions: objective.transitions,
			startTransitions: objective.startTransitions,
			endTransitions: objective.endTransitions,
			...(adjustments ? { transitionAdjustments: adjustments } : {}),
		},
		path
	)

	return parts.emissions + parts.transitions + parts.adjustments
}

/**
 * Restricts a prior matrix to the emission shape, reading a missing row
 * or column as zero, as `addEmissionMatrix` does.
 */
function fitToEmissions(matrix: Matrix, rows: number, width: number): number[][] {
	const fitted: number[][] = []

	for (let t = 0; t < rows; t++) {
		const row = matrix[t]
		const out = new Array<number>(width)

		for (let k = 0; k < width; k++) {
			out[k] = row?.[k] ?? 0
		}

		fitted.push(out)
	}

	return fitted
}

function zeroTerms(): DecodeTermValues {
	return Object.fromEntries(DECODE_TERMS.map((term) => [term, 0])) as DecodeTermValues
}

function sumTerms(values: DecodeTermValues): number {
	let total = 0

	for (const term of DECODE_TERMS) {
		total += values[term]
	}

	return total
}

/**
 * Groups a label path into spans: a run of `O` pieces, or a run of one tag that
 * starts at its first piece or at a `B-` label.
 */
function decodedSpans(labelNames: readonly string[]): Array<{ pieceStart: number; pieceEnd: number; tag: string }> {
	const spans: Array<{ pieceStart: number; pieceEnd: number; tag: string }> = []

	labelNames.forEach((label, t) => {
		const tag = label === "O" ? "O" : label.replace(/^[BI]-/, "")
		const last = spans.at(-1)

		if (last && last.tag === tag && !label.startsWith("B-")) {
			last.pieceEnd = t + 1
		} else {
			spans.push({ pieceStart: t, pieceEnd: t + 1, tag })
		}
	})

	return spans
}

/**
 * The inputs {@link explainDecode} reads, all from the decode being explained.
 */
export interface ExplainDecodeInput {
	objective: DecodeObjective

	/**
	 * The emission matrix the decoder ran on.
	 */
	emissions: number[][]

	/**
	 * The decoder's path, before any repair pass.
	 */
	path: readonly number[]

	/**
	 * The score `viterbi` returned for the path, null under argmax decoding.
	 */
	viterbiScore: number | null
	labels: readonly string[]
	pieces: ReadonlyArray<{ piece: string; start: number; end: number }>
	text: string
}

/**
 * Explains one decode by the objective it maximized.
 *
 * Every number comes from the matrices and transitions the decoder summed.
 * The function throws when those quantities do not reproduce the decoder's emission matrix exactly
 * or its path, because an explanation of a different objective would be wrong without showing it.
 */
export function explainDecode(input: ExplainDecodeInput): DecodeExplanation {
	const { objective, emissions, path, labels, pieces, text } = input
	const rows = emissions.length
	const width = emissions[0]?.length ?? 0

	const composed = composeEmissions(objective)

	if (composed.length !== rows || composed.some((row, t) => row.some((v, k) => !Object.is(v, emissions[t]![k])))) {
		throw new Error("explainDecode: the captured priors do not reproduce the decoder's emission matrix")
	}

	const redecoded = decodePath(objective, emissions)

	if (redecoded.length !== path.length || redecoded.some((label, t) => label !== path[t])) {
		throw new Error("explainDecode: re-decoding the captured objective does not reproduce the decoder's path")
	}

	const labelName = (k: number): string => labels[k] ?? `#${k}`
	const pieceText = (t: number): string => pieces[t]?.piece ?? `#${t}`

	// Per-cell term matrices whose sum over terms is the emission the decoder read.
	const emissionTerms: Array<{ term: DecodeTerm; matrix: number[][] }> = [
		{ term: "logits", matrix: fitToEmissions(objective.logits, rows, width) },
		...objective.emissionPriors.map(({ term, matrix }) => ({ term, matrix: fitToEmissions(matrix, rows, width) })),
	]

	const masked = objective.maskedLabels

	if (masked?.size) {
		const preMask = composeEmissions(objective, "conventionsMask")

		emissionTerms.push({
			term: "conventionsMask",
			matrix: preMask.map((row) => row.map((v, k) => (masked.has(k) ? MASKED_EMISSION - v : 0))),
		})
	}

	const transitionInput = {
		emissions,
		transitions: objective.transitions,
		startTransitions: objective.startTransitions,
		endTransitions: objective.endTransitions,
		...(objective.transitionAdjustments ? { transitionAdjustments: objective.transitionAdjustments } : {}),
	}

	const termValues = (labelPath: readonly number[]): DecodeTermValues => {
		const values = zeroTerms()

		for (const { term, matrix } of emissionTerms) {
			let sum = 0

			for (let t = 0; t < labelPath.length; t++) {
				sum += matrix[t]![labelPath[t]!]!
			}

			values[term] += sum
		}

		if (objective.decode === "viterbi") {
			const parts = viterbiPathTerms(transitionInput, labelPath)
			values.transitions = parts.transitions
			values.placetypePairTransitions = parts.adjustments
		}

		return values
	}

	const decodedTerms = termValues(path)
	const decodedTotal = sumTerms(decodedTerms)
	const decodedNames = path.map(labelName)

	const changesBetween = (from: readonly number[], to: readonly number[]): PieceLabelChange[] =>
		from.flatMap((label, t) =>
			label === to[t] ? [] : [{ piece: t, text: pieceText(t), from: labelName(label), to: labelName(to[t]!) }]
		)

	const spanBounds = decodedSpans(decodedNames)

	const spans: DecodeSpanExplanation[] = spanBounds.map(({ pieceStart, pieceEnd, tag }) => {
		let best: { path: number[]; total: number } | null = null

		// The best reading that relabels at least one piece of the span is the best,
		// over the span's pieces, of the best reading that relabels that piece.
		for (let t = pieceStart; t < pieceEnd; t++) {
			const forced = emissions.slice()
			forced[t] = emissions[t]!.map((v, k) => (k === path[t] ? Number.NEGATIVE_INFINITY : v))
			const candidate = decodePath(objective, forced)

			if (candidate[t] === path[t]) continue
			const total = sumTerms(termValues(candidate))

			if (!best || total > best.total) {
				best = { path: candidate, total }
			}
		}

		// A runner that returns more rows than pieces leaves trailing rows without offsets, read as the text's end.
		const start = pieces[pieceStart]?.start ?? text.length
		const end = pieces[pieceEnd - 1]?.end ?? text.length

		const span = {
			pieceStart,
			pieceEnd,
			start,
			end,
			text: text.slice(start, end),
			tag,
			labels: decodedNames.slice(pieceStart, pieceEnd),
		}

		if (!best) return { ...span, runnerUp: null, margin: null, termMargins: null }

		const runnerTerms = termValues(best.path)
		const termMargins = zeroTerms()

		for (const term of DECODE_TERMS) {
			termMargins[term] = decodedTerms[term] - runnerTerms[term]
		}

		return {
			...span,
			runnerUp: {
				labels: best.path.slice(pieceStart, pieceEnd).map(labelName),
				changes: changesBetween(path, best.path),
				total: best.total,
			},
			margin: decodedTotal - best.total,
			termMargins,
		}
	})

	const spanOfPiece = (t: number): number => spanBounds.findIndex((s) => s.pieceStart <= t && t < s.pieceEnd)

	const ledgerPriors: LedgerPrior[] = [
		...objective.emissionPriors.map(({ term }) => term),
		...(objective.transitionAdjustments?.length && !objective.emissionPriors.some((p) => p.term === "placetypePair")
			? (["placetypePair"] as const)
			: []),
		...(masked?.size ? (["conventionsMask"] as const) : []),
	]

	const ledger: PriorLedgerEntry[] = ledgerPriors.flatMap((prior) => {
		const termMatrix = emissionTerms.find((entry) => entry.term === prior)?.matrix
		const cells: PriorLedgerEntry["cells"] = []

		termMatrix?.forEach((row, t) =>
			row.forEach((delta, k) => {
				if (delta !== 0) {
					cells.push({ piece: t, label: labelName(k), delta })
				}
			})
		)

		const transitionBonuses =
			prior === "placetypePair" && objective.decode === "viterbi"
				? (objective.transitionAdjustments ?? []).map((adj) => ({
						piece: adj.timestep,
						label: labelName(adj.toLabel),
						bonus: adj.bonus,
					}))
				: []

		// A prior with an all-zero matrix and no transition bonus left every emission as it was.
		// `TracePrior.applied` reports such a prior as false, and the ledger omits it.
		if (!cells.length && !transitionBonuses.length) return []

		const without = composeEmissions(objective, prior)
		const pathWithout = decodePath(objective, without, prior)
		const changes = changesBetween(path, pathWithout)

		return [
			{
				prior,
				cells,
				transitionBonuses,
				decodedPathContribution:
					decodedTerms[prior] + (prior === "placetypePair" ? decodedTerms.placetypePairTransitions : 0),
				changes,
				changedSpans: [...new Set(changes.map((change) => spanOfPiece(change.piece)))],
				totalWithout: objectiveTotal(objective, without, pathWithout, prior),
			},
		]
	})

	const decoderScore = input.viterbiScore ?? objectiveTotal(objective, emissions, path)

	return { decoderScore, decodedTerms, spans, ledger }
}
