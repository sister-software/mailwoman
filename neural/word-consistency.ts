/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-word BIO tag-consistency repair (#727 + the fr.country / admin-token fragmentation class).
 *
 *   The model emits per-PIECE BIO labels. On rows where an admin token is adjacent to a non-latin
 *   (byte-fallback) locality, carries diacritics, or is all-caps/reordered, the per-piece labels
 *   can DISAGREE within a single word — `VERMONT` → `VER`[B-locality] + `MONT`[B-region], `Lozère`
 *   → `Loz`[locality] + `ère`[B-region] — and the span decoder reads that as a tag-change
 *   mid-token, fracturing the admin component. The model already KNOWS the word's tag (99.7% of
 *   normal rows are unanimous); the defect is the lack of a word-level consistency constraint.
 *
 *   Fix (DeepSeek-Pro consult `contested-frag`, 2026-06-19): a SentencePiece word — a `▁`-started
 *   piece + its non-`▁` continuations — must carry ONE tag. The tag is chosen by a
 *   CONFIDENCE-WEIGHTED vote, NOT first-piece-wins: sum each piece's softmax mass per TAG TYPE
 *   (B-X
 *
 *   - I-X collapsed; `O` included) across the word, argmax the type, and force `B-<type>` then
 *       `I-<type>` (or all `O`). The near-certain `ère`→region then pulls the whole word to region,
 *       healing both the fragment and the `Loz` bleed. Operates ONLY within a `▁`-delimited word,
 *       so cross-word multi-token names ("Saint Paul" → two words) are untouched and the decoder's
 *       existing cross-word merge still joins them.
 *
 *   Safety: a word whose pieces already agree is left byte-identical (no change). The vote includes
 *   `O`, so an all-`O` word stays `O` (no spurious spans).
 *
 *   Gate outcome (2026-06-19, fr-admin-split-gate + per-locale-f1, MAILWOMAN_WORD_CONSISTENCY=1): NOT
 *   a clean win, so this ships DEFAULT-OFF. It heals clean-latin fragments (`PRUNIÈRES LOZÈRE
 *   FRANCE` → region=`LOZÈRE`), but on OOD byte-soup rows where the per-piece confidence is itself
 *   unreliable the vote AMPLIFIES that noise — e.g. `VERMONT, ウェストミンスター` lets the region word
 *   absorb the adjacent CJK locality — and it net-regressed street −12.6 on the adversarial golden.
 *   The confidence-weighted vote out-votes a stray mis-tagged piece only when the surviving pieces
 *   are themselves trustworthy; on byte-fallback pieces that premise breaks. A confidence-gated
 *   variant (skip the heal when the word's mean p(bestType) is below a floor, or when any piece is
 *   a raw byte-fallback piece) is the path to a clean win — tracked on #727.
 */

import { SPACE_SENTINEL } from "./tokenizer.js"
import { softmax } from "./viterbi.js"

export interface WordConsistencyResult {
	/** A new per-piece label-index array, word-consistent (input is not mutated). */
	labelIndices: number[]
	/** PieceIndex → mean p(chosen type) across the word, for pieces in a word that was HEALED. */
	healedConfidence: Map<number, number>
	/** Count of words whose labels were rewritten (0 = byte-identical to the input). */
	healedWords: number
}

/** The tag TYPE of a BIO label: `"region"` from `B-region`/`I-region`; `"O"` from `O`. */
function labelType(label: string): string {
	if (label === "O") return "O"
	const dash = label.indexOf("-")
	return dash >= 0 ? label.slice(dash + 1) : label
}

/**
 * Rewrite per-piece label indices so every `▁`-delimited word carries one tag, chosen by a
 * confidence-weighted vote over the post-prior `emissions`. See the module docstring.
 *
 * @param pieces SentencePiece pieces (the `▁`-marked surface is the word-boundary signal).
 * @param emissions Per-piece × per-label scores AFTER all priors/masks (the distribution the argmax
 *   would see). Softmaxed per piece for the vote so each piece's confidence carries its weight.
 * @param labels The BIO label vocabulary (index ↔ label).
 * @param labelIndices The current per-piece decision (viterbi path or argmax). Not mutated.
 */
export function enforceWordConsistency(
	pieces: ReadonlyArray<{ piece: string }>,
	emissions: ReadonlyArray<ReadonlyArray<number>>,
	labels: readonly string[],
	labelIndices: readonly number[]
): WordConsistencyResult {
	// Type → {B index, I index}; the standalone O index; per-label-index → type.
	const typeB = new Map<string, number>()
	const typeI = new Map<string, number>()
	const idxType = labels.map((l, idx) => {
		const t = labelType(l)
		if (l.startsWith("B-")) typeB.set(t, idx)
		else if (l.startsWith("I-")) typeI.set(t, idx)
		return t
	})
	const oIdx = labels.indexOf("O")

	const out = [...labelIndices]
	const healedConfidence = new Map<number, number>()
	let healedWords = 0

	// Group pieces into words. A word = a `▁`-started piece + its non-`▁` continuations. A bare `▁`
	// (whitespace-only) piece is a SEPARATOR — it ends the current word and joins no word (its label
	// is left as-is, matching the decoder's "zero-width O is not a boundary" handling).
	const words: number[][] = []
	let cur: number[] = []
	const flush = (): void => {
		if (cur.length) words.push(cur)
		cur = []
	}
	for (let i = 0; i < pieces.length; i++) {
		const pc = pieces[i]!.piece
		const isSentinel = pc.startsWith(SPACE_SENTINEL)
		const content = isSentinel ? pc.slice(SPACE_SENTINEL.length) : pc
		if (content.trim() === "") {
			// Separator (bare `▁` or whitespace) — ends the current word, belongs to none.
			flush()
			continue
		}
		if (isSentinel) {
			flush()
			cur = [i]
		} else {
			// Continuation. (An orphan continuation with no started word — shouldn't happen since the
			// input's first piece is `▁`-marked — defensively starts its own word.)
			cur.push(i)
		}
	}
	flush()

	for (const w of words) {
		// Confidence-weighted vote: sum each piece's softmax mass per TYPE (B-X + I-X) across the word.
		const score = new Map<string, number>()
		for (const pi of w) {
			const probs = softmax([...emissions[pi]!])
			for (let li = 0; li < probs.length; li++) {
				const t = idxType[li]!
				score.set(t, (score.get(t) ?? 0) + probs[li]!)
			}
		}
		let bestType = "O"
		let bestScore = -1
		for (const [t, s] of score) {
			if (s > bestScore) {
				bestScore = s
				bestType = t
			}
		}
		// Target label index per piece: B-<type> for the first piece, I-<type> for the rest (or O).
		const targets = w.map((_pi, k) => {
			if (bestType === "O") return oIdx
			return k === 0 ? (typeB.get(bestType) ?? oIdx) : (typeI.get(bestType) ?? oIdx)
		})
		const changed = w.some((pi, k) => out[pi] !== targets[k])
		if (!changed) continue // word already consistent → byte-identical, leave it
		healedWords++
		const meanConf = bestScore / w.length // mean p(bestType) — length-invariant (DeepSeek t3)
		w.forEach((pi, k) => {
			out[pi] = targets[k]!
			healedConfidence.set(pi, meanConf)
		})
	}

	return { labelIndices: out, healedConfidence, healedWords }
}
