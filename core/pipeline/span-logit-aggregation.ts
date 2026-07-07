/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-span logit aggregation — Option C from the DeepSeek synthesis review.
 *
 *   Takes the per-token logits already emitted by the ONNX model (currently discarded after argmax in
 *   `classifier.ts`) and aggregates them over phrase-grouper spans to produce per-span top-K tag
 *   candidates. These feed directly into `reconcileSpans` as the `classifierTopK` input.
 *
 *   Why this instead of a sequence-level beam decoder: the reconciler takes `(span, tag, score)`
 *   triples — per-span confidence, not BIO-sequence-level confidence. The phrase grouper has
 *   already done boundary discovery. This module answers "given these boundaries, what tags does
 *   the classifier think each span is?" — which is the right abstraction for joint decoding.
 *
 *   Code path matches the eventual production runtime: when a top-k-trained classifier exists, the TS
 *   runtime just swaps "per-token softmax aggregation" for "classifier's native top-k API." Same
 *   downstream contract.
 */

import type { ComponentTag } from "../types/component.js"
import type { ClassifierCandidate } from "./reconcile.js"

/**
 * A token piece with character-level offsets into the original text.
 */
export interface TokenPiece {
	start: number
	end: number
}

/**
 * A span proposal from the phrase grouper, in character offsets.
 */
export interface SpanBounds {
	start: number
	end: number
}

/**
 * Given per-token logits and phrase-grouper spans, produce per-span top-K tag candidates.
 *
 * For each span, finds the tokens whose character ranges overlap the span, sums their softmax probabilities per-tag,
 * normalizes, and emits the top K tags with their aggregated scores.
 *
 * BIO prefix stripping: the model emits BIO labels (`B-locality`, `I-locality`, etc.) but the reconciler works with
 * component tags (`locality`). This function strips the `B-`/`I-` prefix and merges probabilities: `score(locality) =
 * sum(score(B-locality) + score(I-locality))` across the span's tokens.
 *
 * @param logits Per-token logits from ONNX inference, shape `[seqLen][numLabels]`.
 * @param pieces Token pieces with character-level offsets (from the tokenizer's `encode`).
 * @param spans Phrase-grouper span proposals in character offsets.
 * @param opts Options bag.
 * @param opts.topK Number of top-scoring tags to return per span (default 3).
 * @param opts.labels The BIO label vocabulary the model emits, e.g. `["O", "B-locality", ...]`.
 */
export function aggregateSpanLogits(
	logits: number[][],
	pieces: readonly TokenPiece[],
	spans: readonly SpanBounds[],
	opts: { topK?: number; labels: readonly string[]; text?: string }
): ClassifierCandidate[] {
	const topK = opts.topK ?? 3
	const labels = opts.labels
	const text = opts.text

	const candidates: ClassifierCandidate[] = []

	for (const span of spans) {
		// Inherently-numeric components can't live on a span with no digit. An OOD model facing the
		// "<postcode> <City>" order routinely mistags the trailing city as a postcode (Toulouse →
		// postcode:0.77); since postcodes and house numbers contain a digit in every locale we handle,
		// drop those candidates for a digit-less span so the reconciler picks the real component (#425).
		const spanHasNoDigit = text !== undefined && !/\d/.test(text.slice(span.start, span.end))
		// Find tokens overlapping this span (character-level).
		const overlapping: number[] = []

		for (let t = 0; t < pieces.length; t++) {
			const p = pieces[t]!

			if (p.end <= span.start) continue

			if (p.start >= span.end) break
			overlapping.push(t)
		}

		if (overlapping.length === 0) continue

		// Aggregate softmax probabilities per component tag (strip BIO prefix).
		const tagScores = new Map<string, number>()

		for (const t of overlapping) {
			const probs = softmax(logits[t]!)

			for (let l = 0; l < labels.length; l++) {
				const bioLabel = labels[l]!
				const tag = stripBIOPrefix(bioLabel)

				if (tag === "O") continue

				if (spanHasNoDigit && (tag === "postcode" || tag === "house_number")) continue
				const prev = tagScores.get(tag) ?? 0
				tagScores.set(tag, prev + probs[l]!)
			}
		}

		// Normalize by number of overlapping tokens so longer spans don't auto-win.
		const norm = overlapping.length
		const sorted = [...tagScores.entries()]
			.map(([tag, score]) => ({ tag, score: score / norm }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK)

		for (const { tag, score } of sorted) {
			candidates.push({
				span: { start: span.start, end: span.end },
				tag: tag as ComponentTag,
				score,
			})
		}
	}

	return candidates
}

/**
 * Strip `B-` or `I-` prefix from a BIO label, returning the component tag. `O` returns `"O"`.
 */
function stripBIOPrefix(label: string): string {
	if (label === "O") return "O"
	const dash = label.indexOf("-")

	if (dash === -1) return label

	return label.slice(dash + 1)
}

/** Numerically stable softmax over a row of logits. */
function softmax(row: readonly number[]): number[] {
	let max = row[0]!

	for (let i = 1; i < row.length; i++)
		if (row[i]! > max) {
			max = row[i]!
		}
	const exps = row.map((v) => Math.exp(v - max))
	const sum = exps.reduce((a, b) => a + b, 0)

	return exps.map((e) => e / sum)
}
