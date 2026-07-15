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
 *   Safety: a word whose pieces already agree IN TYPE is left byte-identical — enforced structurally
 *   (the vote never runs on a type-consistent word; single-piece words are trivially consistent).
 *   Until 2026-07-15 this held only when the vote happened to agree with the decoder, which let the
 *   heal RE-DECODE consistent words from local type-mass and override viterbi (`▁Broadway`
 *   B-street→O; all-street `Gamle` →locality) — the mechanism behind the 2026-06-19 street
 *   regression below. The vote includes `O`, so a disagreeing word can still resolve to all-`O`.
 *
 *   Gate outcome (2026-06-19, fr-admin-split-gate + per-locale-f1, MAILWOMAN_WORD_CONSISTENCY=1): NOT
 *   a clean win — net-regressed street −12.6 on the adversarial golden — so it shipped DEFAULT-OFF,
 *   with a confidence-gated variant hypothesized as the path to a clean win.
 *
 *   Re-diagnosis (2026-07-15): the regression was NOT vote noise — it was two defects in this module.
 *   (1) The heal re-decoded words whose pieces already AGREED whenever the local type-mass preferred
 *   another type, overriding viterbi (`▁Broadway` B-street→O; all-street `Gamle`→locality). Fixed
 *   structurally: the vote now only runs on words whose pieces disagree in type. (2) Punctuation
 *   continuation pieces joined the preceding word's vote group (`Ave` + `,`), and their `O` mass
 *   manufactured fake disagreements that killed real spans — the `WordConsistencyOpts.splitOnPunctuation`
 *   gate. With both fixed (+ `skipByteFallbackWords`), the heal is a clean win with NO confidence floor:
 *   golden us street 82.0→82.2, fr macro 42.2→51.5, adversarial flat; parity house_number .767→.808,
 *   postcode →1.000, street .543→.573; error-analysis 2pp gate PASS. Ships ON at the pipeline call
 *   sites via `WORD_CONSISTENCY_SHIP_DEFAULT` (core/pipeline/types.ts). A `minMeanConfidence` floor
 *   was measured NET-NEGATIVE on the parity corpus (fragment rows are low-confidence but heal
 *   correctly) — it exists as an opt, unused by the ship default.
 */

import { SPACE_SENTINEL } from "./tokenizer.ts"
import { softmax } from "./viterbi.ts"

export interface WordConsistencyOpts {
	/**
	 * Skip the heal when the vote's mean p(bestType) across the word is below this floor. The ungated variant's failure
	 * mode (the 2026-06-19 gate) was amplifying noise on rows where the per-piece confidence is itself unreliable — a
	 * low-confidence vote is exactly that signature. `0` (default) never skips.
	 */
	minMeanConfidence?: number
	/**
	 * Skip healing any word containing a raw byte-fallback piece (`<0xNN>`). On byte-soup words the
	 * confidence-weighted-vote premise ("the surviving pieces are trustworthy") breaks — see the module docstring's gate
	 * outcome. Default false.
	 */
	skipByteFallbackWords?: boolean
	/**
	 * Treat a pure-punctuation piece (no letters/digits) as a word-group separator, like whitespace. Punctuation is never
	 * word-content for tag purposes, but SentencePiece can emit it as a continuation piece that joins the preceding
	 * word's group — `Ave` + `,` — where its `O` label manufactures a fake intra-word disagreement and the vote kills the
	 * real span (the 2026-07-15 golden `street_suffix`→O class). Also keeps the halves of a slash compound (`12/345` =
	 * unit 12 + house number 345) voting independently. Default false.
	 */
	splitOnPunctuation?: boolean
}

/** A piece that is punctuation-only (no letter or digit in any script). */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u

/** A raw SentencePiece byte-fallback piece (`<0xE3>` …) — emitted for characters absent from the vocab. */
const BYTE_FALLBACK = /^<0x[0-9A-Fa-f]{2}>$/

/**
 * Interpret the `MAILWOMAN_WORD_CONSISTENCY` env string as a heal setting. `"1"` = the original ungated vote; `"gated"`
 * = the #727 gated preset (slash grouping + byte-fallback skip, no confidence floor); `"gated:<floor>"` adds a
 * `minMeanConfidence` floor (e.g. `"gated:0.5"`). Anything else (unset included) = off.
 */
export function parseWordConsistencyEnv(value: string | undefined): boolean | WordConsistencyOpts {
	if (value === "1") return true

	if (value?.startsWith("gated")) {
		const opts: WordConsistencyOpts = { skipByteFallbackWords: true, splitOnPunctuation: true }
		const floor = Number.parseFloat(value.slice("gated:".length))

		if (Number.isFinite(floor) && floor > 0) {
			opts.minMeanConfidence = floor
		}

		return opts
	}

	return false
}

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
 * Rewrite per-piece label indices so every `▁`-delimited word carries one tag, chosen by a confidence-weighted vote
 * over the post-prior `emissions`. See the module docstring.
 *
 * @param pieces SentencePiece pieces (the `▁`-marked surface is the word-boundary signal).
 * @param emissions Per-piece × per-label scores AFTER all priors/masks (the distribution the argmax would see).
 *   Softmaxed per piece for the vote so each piece's confidence carries its weight.
 * @param labels The BIO label vocabulary (index ↔ label).
 * @param labelIndices The current per-piece decision (viterbi path or argmax). Not mutated.
 * @param opts Optional gates on the heal (confidence floor, byte-fallback skip, slash grouping) — the #727-tracked
 *   "confidence-gated variant". Omitted = the original ungated behavior, byte-identical.
 */
export function enforceWordConsistency(
	pieces: ReadonlyArray<{ piece: string }>,
	emissions: ReadonlyArray<ReadonlyArray<number>>,
	labels: readonly string[],
	labelIndices: readonly number[],
	opts?: WordConsistencyOpts
): WordConsistencyResult {
	// Type → {B index, I index}; the standalone O index; per-label-index → type.
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

	// Group pieces into words. A word = a `▁`-started piece + its non-`▁` continuations. A bare `▁`
	// (whitespace-only) piece is a SEPARATOR — it ends the current word and joins no word (its label
	// is left as-is, matching the decoder's "zero-width O is not a boundary" handling).
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
			// Separator (bare `▁` or whitespace) — ends the current word, belongs to none.
			flush()
			continue
		}

		if (opts?.splitOnPunctuation && PUNCTUATION_ONLY.test(content)) {
			// Punctuation separator — `12/345`'s halves vote independently; a trailing `,` never joins
			// `Ave`'s group. The piece itself joins no word (its label is left as-is, like whitespace).
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
		// The heal arbitrates INTRA-WORD DISAGREEMENT only. A word whose pieces already share one type
		// (a single-piece word trivially does) is the decoder's global decision — re-deciding it from
		// local type-mass is a re-decode, not a consistency repair, and is exactly what regressed
		// golden street (`▁Broadway` B-street→O, consistent `Gamle` street→locality, 2026-07-15).
		const currentTypes = new Set(w.map((pi) => idxType[labelIndices[pi]!] ?? "O"))

		if (currentTypes.size <= 1) continue

		// Byte-fallback gate: on a word with raw byte pieces the per-piece confidences the vote relies
		// on are themselves unreliable — leave the word untouched.
		if (opts?.skipByteFallbackWords && w.some((pi) => BYTE_FALLBACK.test(pieces[pi]!.piece))) continue

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
		const meanConf = bestScore / w.length
		// mean p(bestType) — length-invariant (DeepSeek t3)

		// Confidence gate: a low-confidence vote is the noise-amplification signature the 2026-06-19
		// gate caught — skip the heal rather than force an unreliable consensus.
		if (opts?.minMeanConfidence && meanConf < opts.minMeanConfidence) continue
		healedWords++
		w.forEach((pi, k) => {
			out[pi] = targets[k]!
			healedConfidence.set(pi, meanConf)
		})
	}

	return { labelIndices: out, healedConfidence, healedWords }
}
