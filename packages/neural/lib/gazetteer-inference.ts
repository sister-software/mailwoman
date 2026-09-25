/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { TokenizedPiece } from "#tokenizer"

/**
 * The width of the gazetteer candidate-tag channel, used for the ONNX zero fallback
 * when a gazetteer-trained model runs without clue data.
 *
 * It must match the lexicon's `feature_dim` and the model's `gazetteer_feature_dim`.
 */
export const GAZETTEER_FEATURE_DIM = 5

/**
 * The width of the street-type evidence channel, used for the runner's zero fallback
 * and checked against the lexicon's `feature_dim`.
 */
export const STREET_TYPE_FEATURE_DIM = 1

/**
 * Locality-surface evidence channel width (locality + locality_homograph).
 */
export const LOCALITY_SURFACE_FEATURE_DIM = 2

/**
 * The loaded lexicon — the JSON shape from build-gazetteer-anchor-lexicon.mjs.
 */
export interface GazetteerLexicon {
	featureDim: number
	slots: readonly string[]
	bits: Record<string, number>
	maxNgram: number

	/**
	 * Maps a lowercased n-gram to its slot bitmask for case-insensitive matching.
	 */
	entries: Map<string, number>

	/**
	 * Maps an uppercase single-word code to its slot bitmask, matched case-sensitively against the surface.
	 */
	codeEntries: Map<string, number>

	/**
	 * Whether a matched span paints nothing when a span word or its nearest
	 * non-empty neighbor contains a decimal digit.
	 *
	 * It is read from the artifact's `rules.digit_guard` so training and inference
	 * apply the same rule, and it is `false` on older artifacts.
	 */
	digitGuard: boolean
}

/**
 * Validates an already-parsed gazetteer lexicon JSON object and converts it to a {@link GazetteerLexicon}.
 *
 * It takes parsed JSON rather than a path so the module stays browser-safe.
 */
export function parseGazetteerLexicon(raw: {
	feature_dim: number
	slots: string[]
	bits: Record<string, number>
	max_ngram: number
	entries: Record<string, number>
	code_entries: Record<string, number>
	rules?: { digit_guard?: boolean }
}): GazetteerLexicon {
	if (typeof raw?.feature_dim !== "number" || raw.feature_dim <= 0) {
		throw new Error(`gazetteer lexicon: feature_dim must be a positive number, got ${raw?.feature_dim}`)
	}

	if (!Array.isArray(raw.slots) || !raw.slots.length) {
		throw new Error("gazetteer lexicon: slots must be a non-empty array")
	}

	if (typeof raw.max_ngram !== "number" || raw.max_ngram < 1) {
		throw new Error(`gazetteer lexicon: max_ngram must be >= 1, got ${raw.max_ngram}`)
	}

	for (const field of ["bits", "entries", "code_entries"] as const) {
		if (typeof raw[field] !== "object" || raw[field] === null) {
			throw new Error(`gazetteer lexicon: ${field} must be an object`)
		}
	}

	return {
		featureDim: raw.feature_dim,
		slots: raw.slots,
		bits: raw.bits,
		maxNgram: raw.max_ngram,
		entries: new Map(Object.entries(raw.entries)),
		codeEntries: new Map(Object.entries(raw.code_entries)),
		digitGuard: raw.rules?.digit_guard === true,
	}
}

const hasDecimal = (word: string): boolean => /\p{Nd}/u.test(word)

function digitAdjacent(words: readonly NormWord[], i: number, matchedN: number): boolean {
	for (let k = i; k < i + matchedN; k++) {
		if (hasDecimal(words[k]!.text)) return true
	}

	let k = i - 1

	while (k >= 0 && !words[k]!.text) {
		k--
	}

	if (k >= 0 && hasDecimal(words[k]!.text)) return true
	k = i + matchedN

	while (k < words.length && !words[k]!.text) {
		k++
	}

	return k < words.length && hasDecimal(words[k]!.text)
}

function stripWord(word: string): string {
	let start = 0
	let end = word.length
	const alnum = (c: string) => /[\p{L}\p{N}]/u.test(c)

	while (start < end && !alnum(word[start]!)) {
		start++
	}

	while (end > start && !alnum(word[end - 1]!)) {
		end--
	}

	return word.slice(start, end)
}

function bitsToRow(bits: number, lexicon: GazetteerLexicon): number[] {
	return lexicon.slots.map((slot) => (bits & lexicon.bits[slot]! ? 1 : 0))
}

interface NormWord {
	begin: number
	end: number
	text: string
}

/**
 * Scan the raw surface and paint each char with its candidate-tag bitmask (mirrors Python).
 */
export function gazetteerCharPaint(text: string, lexicon: GazetteerLexicon): number[] {
	const charBits = new Array<number>(text.length).fill(0)
	const wordRe = /\S+/g
	const words: NormWord[] = []
	let m: RegExpExecArray | null

	while ((m = wordRe.exec(text)) !== null) {
		const surface = m[0]
		const stripped = stripWord(surface)

		if (!stripped) {
			words.push({ begin: m.index, end: m.index, text: "" })

			continue
		}

		let head = 0
		const alnum = (c: string) => /[\p{L}\p{N}]/u.test(c)

		while (head < surface.length && !alnum(surface[head]!)) {
			head++
		}

		words.push({ begin: m.index + head, end: m.index + head + stripped.length, text: stripped })
	}

	let i = 0

	while (i < words.length) {
		if (!words[i]!.text) {
			i++

			continue
		}

		let matchedN = 0
		let matchedBits = 0
		const maxN = Math.min(lexicon.maxNgram, words.length - i)

		for (let n = maxN; n >= 1; n--) {
			const parts: string[] = []
			let ok = true

			for (let k = i; k < i + n; k++) {
				if (!words[k]!.text) {
					ok = false

					break
				}

				parts.push(words[k]!.text)
			}

			if (!ok) continue
			const key = parts.join(" ").toLowerCase()
			let bits = lexicon.entries.get(key) ?? 0

			if (n === 1) {
				// oxlint-disable-next-line oxc/bad-bitwise-operator -- genuine bitmask accumulation rather than a mistyped logical or
				bits |= lexicon.codeEntries.get(parts[0]!) ?? 0
			}

			if (bits) {
				matchedN = n
				matchedBits = bits

				break
			}
		}

		if (matchedN) {
			if (lexicon.digitGuard && digitAdjacent(words, i, matchedN)) {
				i += matchedN

				continue
			}

			const begin = words[i]!.begin
			const end = words[i + matchedN - 1]!.end

			for (let c = begin; c < Math.min(end, text.length); c++) {
				charBits[c] = matchedBits
			}

			i += matchedN
		} else {
			i++
		}
	}

	return charBits
}

/**
 * Returns a copy of the gazetteer features with the clue zeroed on pieces within `window`
 * of a postcode-span piece, which is any piece with `anchorConfidence > 0`.
 *
 * A region clue just before a US postcode otherwise strengthens `B-region` enough to cost the postcode
 * its tag, and the training-side `suppress_gazetteer_near_postcode` must be enabled to match.
 */
export function suppressGazetteerNearPostcode(
	gazetteer: { features: number[][]; confidence: number[] },
	anchorConfidence: ReadonlyArray<number>,
	window = 1
): { features: number[][]; confidence: number[] } {
	const n = gazetteer.confidence.length
	const suppress = new Array<boolean>(n).fill(false)

	for (let i = 0; i < n; i++) {
		if ((anchorConfidence[i] ?? 0) > 0) {
			for (let d = -window; d <= window; d++) {
				const j = i + d

				if (j >= 0 && j < n && d !== 0) {
					suppress[j] = true
				}
			}
		}
	}

	const dim = gazetteer.features[0]?.length ?? 0

	return {
		features: gazetteer.features.map((row, i) => (suppress[i] ? new Array<number>(dim).fill(0) : row)),
		confidence: gazetteer.confidence.map((c, i) => (suppress[i] ? 0 : c)),
	}
}

/**
 * Projects per-character bitmasks onto tokenizer pieces, giving each piece the bits
 * of its first non-whitespace character, or `0` if it has none.
 *
 * Every channel built on {@link gazetteerCharPaint} uses this so the projection
 * matches the label projection.
 */
export function projectCharBitsToPieces(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	charBits: ReadonlyArray<number>
): number[] {
	return pieces.map((p) => {
		for (let c = p.start; c < p.end; c++) {
			if (c < text.length && !/\s/.test(text[c]!)) {
				return charBits[c]!
			}
		}

		return 0
	})
}

/**
 * Builds per-piece gazetteer features and confidences for `text`, with confidence
 * `1` wherever any lexicon bit fires.
 */
export function buildGazetteerFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lexicon: GazetteerLexicon
): { features: number[][]; confidence: number[] } {
	const pieceBits = projectCharBitsToPieces(text, pieces, gazetteerCharPaint(text, lexicon))
	const zero = () => new Array<number>(lexicon.featureDim).fill(0)
	const features: number[][] = []
	const confidence: number[] = []

	for (const bits of pieceBits) {
		features.push(bits ? bitsToRow(bits, lexicon) : zero())
		confidence.push(bits ? 1 : 0)
	}

	return { features, confidence }
}
