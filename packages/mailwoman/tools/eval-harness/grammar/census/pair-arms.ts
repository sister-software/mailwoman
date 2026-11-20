// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Report-only re-decodes of one traced parse under a rewritten placetype-pair prior.
 *
 * Each function reads the trace's captured emissions and the classifier's own prior
 * and decoder parameters, and changes no decoder code.
 */

import { bareBIOTag, type ComponentTag } from "@mailwoman/codex/component"
import type { NeuralAddressClassifier } from "@mailwoman/neural"
import type { PairEdge, PairIndexLike } from "@mailwoman/neural/pair/index/resolver"
import { buildPlacetypePairPriors } from "@mailwoman/neural/placetype/pair-prior"
import type { NeuralParseTrace } from "@mailwoman/neural/trace"
import {
	buildBIOEndMask,
	buildBIOStartMask,
	buildBIOTransitionMask,
	viterbi,
	type ViterbiInput,
	type ViterbiTransitionAdjustment,
} from "@mailwoman/neural/viterbi"

export type Matrix = number[][]

/**
 * Rewrites the edge an index returns for one probe, or drops it with null.
 */
export type EdgeRewrite = (child: string, parent: string, edge: PairEdge) => PairEdge | null

export const keepEdge: EdgeRewrite = (_child, _parent, edge) => edge

export interface PairHit {
	child: string
	parent: string
	edge: PairEdge
}

function recordingIndex(index: PairIndexLike, rewrite: EdgeRewrite) {
	const hits: PairHit[] = []

	const wrapped: PairIndexLike = {
		probe(child, parent) {
			const found = index.probe(child, parent)
			const edge = found && rewrite(child, parent, found)

			if (!edge) return null

			hits.push({ child, parent, edge })

			return edge
		},
		...(index.delta != null ? { delta: index.delta } : {}),
		transitionBeta: index.transitionBeta ?? null,
		parentDelta: index.parentDelta ?? null,
		...(index.country ? { country: index.country } : {}),
	}

	return { wrapped, hits }
}

export interface PairRun {
	matrix: Matrix
	adjustments: ViterbiTransitionAdjustment[]
	hits: PairHit[]
}

/**
 * Builds the classifier's placetype-pair prior for the traced parse,
 * with every index hit passed through `rewrite`.
 *
 * Null when the classifier has no pair index.
 */
export function runPairPrior(
	classifier: NeuralAddressClassifier,
	trace: NeuralParseTrace,
	rewrite: EdgeRewrite,
	/**
	 * Overrides the parent bias, so an index without one still marks its parent window.
	 */
	parentDelta?: number
): PairRun | null {
	const pairOpts = classifier.config.placetypePair

	if (!pairOpts) return null

	const { wrapped, hits } = recordingIndex(pairOpts.index, rewrite)

	const result = buildPlacetypePairPriors(
		{
			...pairOpts,
			...(parentDelta != null ? { parentDelta } : {}),
			index: wrapped,
			inputText: trace.text,
			postcodeSpanMode: classifier.config.postcodeAnchorSpanMode ?? null,
		},
		trace.pieces,
		trace.labels
	)

	const adjustments = result.transitionAdjustments.flatMap((adj) => {
		const toLabel = trace.labels.indexOf(adj.toLabel)

		return toLabel !== -1 ? [{ timestep: adj.pieceIndex, toLabel, bonus: adj.bonus }] : []
	})

	return { matrix: result.matrix, adjustments, hits }
}

const MASK_FLOOR = -1e8
const MASKED = -1e9

/**
 * Matches a piece that holds a letter or digit rather than only a separator.
 */
export const WORD_CONTENT = /[\p{L}\p{N}]/u

/**
 * `emissions` with `remove` subtracted and `add` added, leaving masked cells masked.
 */
export function shiftEmissions(emissions: Matrix, remove: Matrix | null, add: Matrix | null): Matrix {
	return emissions.map((row, t) =>
		row.map((value, k) => (value <= MASK_FLOOR ? value : value - (remove?.[t]?.[k] ?? 0) + (add?.[t]?.[k] ?? 0)))
	)
}

/**
 * The classifier's transitions, composed as its constructor composes them.
 */
export function decoderInput(
	classifier: NeuralAddressClassifier,
	labels: readonly string[]
): Omit<ViterbiInput, "emissions"> {
	const config = classifier.config
	const structural = buildBIOTransitionMask(labels)
	const learned = config.transitions

	return {
		transitions: learned ? structural.map((row, i) => row.map((v, j) => v + (learned[i]?.[j] ?? 0))) : structural,
		startTransitions: config.startTransitions ?? buildBIOStartMask(labels),
		endTransitions: config.endTransitions ?? buildBIOEndMask(labels),
	}
}

/**
 * One edge the prior fired on a row, with the word pieces of each window its bias covered.
 */
export interface FiredWindows {
	tag: ComponentTag
	parentTag: ComponentTag
	childPieces: number[]
	parentPieces: number[]
}

/**
 * The child and parent windows of one hit, recovered by re-running the prior with only that hit admitted.
 *
 * The child window takes the child bias and the parent window the unit parent bias,
 * so the two separate by magnitude even when both ends share a tag.
 * A window counts only its pieces with word content: the segment path also
 * biases the separator piece after the name.
 */
export function hitWindows(
	classifier: NeuralAddressClassifier,
	trace: NeuralParseTrace,
	hit: PairHit
): Pick<FiredWindows, "childPieces" | "parentPieces"> {
	const single = runPairPrior(
		classifier,
		trace,
		(child, parent, edge) => (child === hit.child && parent === hit.parent ? edge : null),
		1
	)!

	const piecesWith = (tag: string, child: boolean) =>
		single.matrix.flatMap((cells, t) =>
			WORD_CONTENT.test(trace.pieces[t]!.piece) &&
			cells.some((delta, k) => (child ? delta > 1 : delta === 1) && bareBIOTag(trace.labels[k]!) === tag)
				? [t]
				: []
		)

	return { childPieces: piecesWith(hit.edge.tag, true), parentPieces: piecesWith(hit.edge.parentTag, false) }
}

/**
 * The label each window piece takes when a path realizes the edge, by piece.
 */
function edgeLabels(edge: FiredWindows, labels: readonly string[]): Map<number, number> | null {
	if (!edge.childPieces.length || !edge.parentPieces.length) return null

	const forced = new Map<number, number>()

	for (const [pieces, tag] of [
		[edge.childPieces, edge.tag],
		[edge.parentPieces, edge.parentTag],
	] as const) {
		pieces.forEach((piece, i) => forced.set(piece, labels.indexOf(`${i === 0 ? "B" : "I"}-${tag}`)))
	}

	return [...forced.values()].every((label) => label !== -1) ? forced : null
}

/**
 * Subsets of more edges than this fall back to the unconstrained decode.
 */
const MAX_JOINT_EDGES = 6

/**
 * The exact optimum of `viterbi score + bonus × realized edges`.
 *
 * For every subset of edges it takes the best path that realizes at least that subset,
 * plus the subset's bonus.
 * A path realizing more than its subset is also the constrained optimum of the
 * larger subset, so the maximum over subsets is exact.
 */
export function jointDecode(
	emissions: Matrix,
	decoder: Omit<ViterbiInput, "emissions">,
	labels: readonly string[],
	edges: readonly FiredWindows[],
	bonus: number
): number[] {
	const forcings = edges.map((edge) => edgeLabels(edge, labels)).filter((forced) => forced !== null)
	let best = viterbi({ emissions, ...decoder })

	if (forcings.length > MAX_JOINT_EDGES) return best.path

	for (let mask = 1; mask < 1 << forcings.length; mask++) {
		const forced = new Map<number, number>()
		let conflict = false
		let count = 0

		forcings.forEach((edge, i) => {
			if (!(mask & (1 << i))) return

			count++

			for (const [piece, label] of edge) {
				if (forced.has(piece) && forced.get(piece) !== label) {
					conflict = true
				}

				forced.set(piece, label)
			}
		})

		if (conflict) continue

		const constrained = emissions.map((row, t) => {
			const label = forced.get(t)

			return label == null ? row : row.map((value, k) => (k === label ? value : MASKED))
		})

		const result = viterbi({ emissions: constrained, ...decoder })

		if (result.score + bonus * count > best.score) {
			best = { path: result.path, score: result.score + bonus * count }
		}
	}

	return best.path
}

/**
 * A decoded path holding a dependent locality and no locality, the structural suite's commonest defect.
 */
export function strandedDependentLocality(tags: readonly string[]): boolean {
	const bare = new Set(tags.map(bareBIOTag))

	return bare.has("dependent_locality") && !bare.has("locality")
}
