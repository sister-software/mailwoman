/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attributes a suite row's parse to the first decoder stage whose labels leave the gold labels.
 *
 *   A traced parse exposes four label sequences over the same pieces: the argmax of the model's logits, the argmax of
 *   the emissions after every prior and mask, the decoder's path, and the final labels after the repair passes. Each
 *   is compared with the gold labels aligned to those pieces, by tag. The comparison ignores B against I, because the
 *   model often opens each word of a span with B and `buildAddressTree` merges adjacent spans of one tag. Street affix
 *   tags fold into `street` on both sides, so a whole-street gold span and a split-street prediction compare equal. A
 *   piece with no letter, mark or digit is ungraded, because the tree trims it from a span's edge. A row whose final
 *   labels match yet fails the exact grade is decided at tree construction or by the grade's convention.
 */

import type { DecoderToken } from "@mailwoman/core/decoder/types"

/**
 * The stage that first produced labels other than the gold labels, in pipeline order.
 */
export const ReplayStage = {
	/**
	 * The argmax of the model's logits already differs.
	 */
	Model: "model",
	/**
	 * The logits' argmax matches, and a prior or mask moved the emissions' argmax off it.
	 */
	Prior: "prior",
	/**
	 * The emissions' argmax matches, and the decoder's path differs (the BIO mask or a transition adjustment).
	 */
	Decoder: "decoder",
	/**
	 * The path matches, and a repair pass changed it.
	 */
	Repair: "repair",
	/**
	 * Every label sequence matches after street folding, and the row still fails the exact grade.
	 */
	TreeOrGrade: "tree-or-grade",
	/**
	 * Every label sequence matches, and the row passes.
	 */
	None: "none",
} as const

export type ReplayStage = (typeof ReplayStage)[keyof typeof ReplayStage]

const STREET_AFFIXES = new Set(["street_prefix", "street_suffix", "street_prefix_particle"])

function bioParts(label: string): { prefix: string; tag: string | null } {
	if (label === "O") return { prefix: "O", tag: null }

	const dash = label.indexOf("-")

	return { prefix: label.slice(0, dash), tag: label.slice(dash + 1) }
}

/**
 * Labels with each street affix folded into `street`: a folded B that continues a street becomes an I.
 *
 * A `null` position (a piece with no text, excluded from comparison) passes through
 * and does not break a street run.
 */
export function foldStreetLabels(labels: ReadonlyArray<string | null>): Array<string | null> {
	const folded: Array<string | null> = []
	let previousTag: string | null = null

	for (const label of labels) {
		if (label === null) {
			folded.push(null)

			continue
		}

		const { prefix, tag } = bioParts(label)
		const foldedTag = tag !== null && STREET_AFFIXES.has(tag) ? "street" : tag

		if (foldedTag === null) {
			folded.push("O")
		} else if (foldedTag === "street" && previousTag === "street" && tag !== "street") {
			folded.push("I-street")
		} else {
			folded.push(`${prefix}-${foldedTag}`)
		}

		previousTag = foldedTag
	}

	return folded
}

/**
 * One gold span in the input's string offsets.
 */
export interface GoldSpan {
	tag: string
	start: number
	end: number
}

/**
 * The gold label of each piece, or `null` for a piece whose text holds no letter, mark
 * or digit (whitespace or punctuation), which no stage is graded on.
 *
 * A piece's text is the characters of `raw` in `[start, end)`, with whitespace trimmed.
 * It takes `B-<tag>` when it begins a span, `I-<tag>` inside one, and `O` outside every span.
 *
 * @returns `null` when a piece straddles a span boundary, because no label sequence
 * over these pieces then equals the gold spans.
 */
export function goldPieceLabels(
	raw: string,
	pieces: ReadonlyArray<{ start: number; end: number }>,
	spans: readonly GoldSpan[]
): Array<string | null> | null {
	const labels: Array<string | null> = []

	for (const piece of pieces) {
		const text = raw.slice(piece.start, piece.end)
		const leading = text.length - text.trimStart().length
		const start = piece.start + leading
		const end = piece.start + text.trimEnd().length

		if (end <= start || !/[\p{L}\p{M}\p{N}]/u.test(raw.slice(start, end))) {
			labels.push(null)

			continue
		}

		const span = spans.find((candidate) => start < candidate.end && end > candidate.start)

		if (!span) {
			labels.push("O")

			continue
		}

		if (start < span.start || end > span.end) return null

		labels.push(`${start === span.start ? "B" : "I"}-${span.tag}`)
	}

	return labels
}

/**
 * Whether `labels` equal `gold` at every graded position, after folding street affixes on both sides.
 */
export function labelsMatchGold(labels: readonly string[], gold: ReadonlyArray<string | null>): boolean {
	if (labels.length !== gold.length) return false

	const masked = labels.map((label, index) => (gold[index] === null ? null : label))
	const foldedLabels = foldStreetLabels(masked)
	const foldedGold = foldStreetLabels(gold)

	const tagOf = (label: string | null) => (label === null ? null : (bioParts(label).tag ?? "O"))

	return foldedLabels.every((label, index) => foldedGold[index] === null || tagOf(label) === tagOf(foldedGold[index]!))
}

/**
 * The four label sequences of one traced parse.
 */
export interface ReplayStages {
	logitsArgmax: string[]
	emissionsArgmax: string[]
	path: string[]
	final: string[]
}

/**
 * Reads the four label sequences from a trace's matrices, path and final tokens.
 */
export function replayStages(
	trace: { logits: number[][]; emissions: number[][]; path: number[]; labels: string[] },
	tokens: readonly DecoderToken[]
): ReplayStages {
	const argmax = (row: readonly number[]) => trace.labels[row.indexOf(Math.max(...row))] ?? "O"

	return {
		logitsArgmax: trace.logits.map(argmax),
		emissionsArgmax: trace.emissions.map(argmax),
		path: trace.path.map((index) => trace.labels[index] ?? "O"),
		final: tokens.map((token) => token.label),
	}
}

/**
 * Whether each of the four label sequences matches the gold labels, in pipeline order.
 */
export function stageMatches(
	stages: ReplayStages,
	gold: ReadonlyArray<string | null>
): [boolean, boolean, boolean, boolean] {
	return [
		labelsMatchGold(stages.logitsArgmax, gold),
		labelsMatchGold(stages.emissionsArgmax, gold),
		labelsMatchGold(stages.path, gold),
		labelsMatchGold(stages.final, gold),
	]
}

/**
 * The stage after which the labels stay off the gold labels through the final labels.
 *
 * It is the stage that follows the last matching sequence, so a logits argmax the
 * decoder corrects and a repair pass then breaks is decided by the repair.
 * With every sequence wrong, the model decided.
 *
 * With the final labels right, the tree-or-grade stage decided a failing row.
 */
export function decidingStage(matches: readonly boolean[], exact: boolean): ReplayStage {
	if (matches[3]) return exact ? ReplayStage.None : ReplayStage.TreeOrGrade

	const order = [ReplayStage.Model, ReplayStage.Prior, ReplayStage.Decoder, ReplayStage.Repair] as const

	return order[matches.lastIndexOf(true) + 1]!
}
