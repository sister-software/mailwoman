/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { SPACE_SENTINEL } from "#tokenizer"
import { softmax } from "#viterbi"

/**
 * Limits which words {@link enforceWordConsistency} relabels.
 *
 * Omitting the options relabels every word whose pieces disagree on entity type.
 */
export interface WordConsistencyOpts {
	/**
	 * Leaves a word unchanged when the winning type's mean probability across its
	 * pieces falls below this floor; `0` or unset never skips.
	 *
	 * A low-confidence vote marks rows where per-piece confidence is unreliable,
	 * and relabelling those amplifies noise.
	 */
	minMeanConfidence?: number

	/**
	 * Leaves any word containing a byte-fallback piece (`<0xNN>`) unchanged, because its
	 * surviving pieces are not trustworthy voters, and defaults to `false`.
	 */
	skipByteFallbackWords?: boolean

	/**
	 * Treats a punctuation-only piece as a word separator, like whitespace, and defaults to `false`.
	 *
	 * Otherwise a continuation piece such as the `,` in `Ave,` joins the word,
	 * and its `O` label can outvote a real span.
	 * Splitting also lets the halves of a slash compound such as `12/345` vote independently.
	 */
	splitOnPunctuation?: boolean
}

const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u

const BYTE_FALLBACK = /^<0x[0-9A-Fa-f]{2}>$/

/**
 * Parses the `MAILWOMAN_WORD_CONSISTENCY` environment value into a setting
 * for {@link enforceWordConsistency}.
 *
 * `"1"` enables the unconditional vote, `"conditional"` or `"conditional:<floor>"` enables
 * the conditional preset with an optional confidence floor, and any other value disables it.
 */
export function parseWordConsistencyEnv(value: string | undefined): boolean | WordConsistencyOpts {
	if (value === "1") return true

	if (value?.startsWith("conditional")) {
		const opts: WordConsistencyOpts = { skipByteFallbackWords: true, splitOnPunctuation: true }
		const floor = Number.parseFloat(value.slice("conditional:".length))

		if (Number.isFinite(floor) && floor > 0) {
			opts.minMeanConfidence = floor
		}

		return opts
	}

	return false
}

/**
 * Holds the relabelled piece indices from {@link enforceWordConsistency}, the vote
 * confidence of each changed piece, and the number of words changed.
 */
export interface WordConsistencyResult {
	/**
	 * Holds the relabelled per-piece label indices in a new array.
	 */
	labelIndices: number[]

	/**
	 * Maps each piece in a relabelled word to the winning type's mean probability across that word.
	 */
	healedConfidence: Map<number, number>

	/**
	 * Counts the words relabelled, so `0` means `labelIndices` equals the input.
	 */
	healedWords: number
}

function labelType(label: string): string {
	if (label === "O") return "O"
	const dash = label.indexOf("-")

	return dash !== -1 ? label.slice(dash + 1) : label
}

/**
 * Relabels SentencePiece pieces so that each `▁`-delimited word carries a single entity type,
 * chosen by a vote over the softmaxed `emissions` of its pieces.
 *
 * The word's first piece gets the `B-` label and the rest get `I-`,
 * and without `opts` every mixed word is relabelled.
 *
 * @param pieces SentencePiece pieces, whose `▁` markers give the word boundaries.
 * @param emissions Per-piece label scores after all priors and masks have been applied.
 * @param labels The BIO label vocabulary, indexed like `emissions`.
 * @param labelIndices The current per-piece decision, which is not mutated.
 * @param opts Optional conditions that limit which words are relabelled.
 */
export function enforceWordConsistency(
	pieces: ReadonlyArray<{ piece: string }>,
	emissions: ReadonlyArray<ReadonlyArray<number>>,
	labels: readonly string[],
	labelIndices: readonly number[],
	opts?: WordConsistencyOpts
): WordConsistencyResult {
	const typeB = new Map<string, number>()
	const typeI = new Map<string, number>()

	const idxType = labels.map((l, idx) => {
		const t = labelType(l)

		if (l.startsWith("B-")) {
			typeB.set(t, idx)
		} else if (l.startsWith("I-")) {
			typeI.set(t, idx)
		}

		return t
	})

	const oIdx = labels.indexOf("O")

	const out = [...labelIndices]
	const healedConfidence = new Map<number, number>()
	let healedWords = 0

	const words: number[][] = []
	let cur: number[] = []

	const flush = (): void => {
		if (cur.length) {
			words.push(cur)
		}

		cur = []
	}

	for (let i = 0; i < pieces.length; i++) {
		const pc = pieces[i]!.piece
		const isSentinel = pc.startsWith(SPACE_SENTINEL)
		const content = isSentinel ? pc.slice(SPACE_SENTINEL.length) : pc

		if (content.trim() === "") {
			flush()

			continue
		}

		if (opts?.splitOnPunctuation && PUNCTUATION_ONLY.test(content)) {
			flush()

			continue
		}

		if (isSentinel) {
			flush()
			cur = [i]
		} else {
			cur.push(i)
		}
	}

	flush()

	for (const w of words) {
		const currentTypes = new Set(w.map((pi) => idxType[labelIndices[pi]!] ?? "O"))

		if (currentTypes.size <= 1) continue

		if (opts?.skipByteFallbackWords && w.some((pi) => BYTE_FALLBACK.test(pieces[pi]!.piece))) continue

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

		const targets = w.map((_pi, k) => {
			if (bestType === "O") return oIdx

			return k === 0 ? (typeB.get(bestType) ?? oIdx) : (typeI.get(bestType) ?? oIdx)
		})

		const changed = w.some((pi, k) => out[pi] !== targets[k])

		if (!changed) continue
		const meanConf = bestScore / w.length

		if (opts?.minMeanConfidence && meanConf < opts.minMeanConfidence) continue

		healedWords++

		w.forEach((pi, k) => {
			out[pi] = targets[k]!
			healedConfidence.set(pi, meanConf)
		})
	}

	return { labelIndices: out, healedConfidence, healedWords }
}
