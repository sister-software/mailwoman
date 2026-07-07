/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Inference-side gazetteer-anchor features (#464, knowledge-ladder rung 3.2) — the TS mirror of the
 *   Python training pipeline (`mailwoman_train/gazetteer_anchor.py`). Both consumers load the SAME
 *   codex-generated lexicon (`scripts/build-gazetteer-anchor-lexicon.mjs` →
 *   `data/gazetteer/anchor-lexicon-v1.json`) whose `rules` encode the match semantics as DATA, so
 *   the two implementations cannot drift. The model conditions on per-token candidate-tag-set clues
 *   fed alongside `input_ids`; this builds them from a raw address + its SentencePiece pieces.
 *
 *   The clue INFORMS, the model decides (model-first). `gazetteer-inference.test.ts` pins the matcher
 *   against the Python fixture: the homograph clue is symmetric, "in" ≠ "IN", multi-word countries
 *   paint every word.
 */

import type { TokenizedPiece } from "./tokenizer.js"

/**
 * The candidate-tag-set feature width: country/region/po_box/cedex/homograph (the lexicon's slot count). Used for the
 * ONNX zero-fallback when a gazetteer-trained model is run with no clue data. MUST match the lexicon JSON's
 * `feature_dim` and the trained model's `gazetteer_feature_dim`.
 */
export const GAZETTEER_FEATURE_DIM = 5

/** The loaded lexicon — the JSON shape from build-gazetteer-anchor-lexicon.mjs. */
export interface GazetteerLexicon {
	featureDim: number
	slots: readonly string[]
	bits: Record<string, number>
	maxNgram: number
	/** Case-insensitive: key = word_norm lowercased → bitmask. */
	entries: Map<string, number>
	/** Case-SENSITIVE: key = word_norm uppercased → bitmask (surface must already be uppercase). */
	codeEntries: Map<string, number>
}

/** Parse the lexicon JSON (already `JSON.parse`d — keeps this module browser-safe; caller reads). */
export function parseGazetteerLexicon(raw: {
	feature_dim: number
	slots: string[]
	bits: Record<string, number>
	max_ngram: number
	entries: Record<string, number>
	code_entries: Record<string, number>
}): GazetteerLexicon {
	// Loud validation (#481): a malformed lexicon previously surfaced as a crash deep inside
	// buildGazetteerFeatures (or worse, silently zero-filled clues — the fake-affix-crash class).
	// Unknown refs fail loud, never silent.
	if (typeof raw?.feature_dim !== "number" || raw.feature_dim <= 0) {
		throw new Error(`gazetteer lexicon: feature_dim must be a positive number, got ${raw?.feature_dim}`)
	}

	if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
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
	}
}

/** Word_norm for one word: strip leading/trailing non-letter/digit chars (keep internal). */
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
	begin: number // char offset of the first kept char
	end: number // char offset after the last kept char
	text: string // the stripped surface (case-preserved)
}

/** Scan the raw surface and paint each char with its candidate-tag bitmask (mirrors Python). */
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

			// code_entries is case-SENSITIVE: the surface must already BE uppercase ("IN" ≠ "in").
			if (n === 1) {
				bits |= lexicon.codeEntries.get(parts[0]!) ?? 0
			}

			if (bits) {
				matchedN = n
				matchedBits = bits
				break
			}
		}

		if (matchedN) {
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
 * Channel choreography (#464, v0.9.13 postcode fix; DeepSeek 2026-06-10): zero the gazetteer clue on pieces within
 * `window` of a postcode-anchor hit. The clue fires on the region token (`CA`/`GA`) immediately before a US postcode;
 * its additive vector strengthens `B-region`, which makes the `B-region → B-postcode` CRF transition less competitive
 * and drops the postcode (~3pp, US-only — FR postcode precedes the locality, no region neighbor). Suppressing the clue
 * adjacent to the postcode removes the interference while leaving every other clue intact. Returns a NEW
 * features/confidence pair (does not mutate). `anchorConfidence[i] > 0` marks postcode-span pieces. PAIRS WITH the
 * train-time half (`gazetteer_anchor.suppress_gazetteer_near_postcode`) — enable both or neither.
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
 * Per-piece gazetteer features + confidence for `text`, projected onto its SP `pieces` by the SAME char→piece rule the
 * labels use (a piece takes the bits of the first non-whitespace char it covers). Returns `(pieces × featureDim)`
 * features + `(pieces,)` confidence (1.0 wherever any bit fires).
 */
export function buildGazetteerFeatures(
	text: string,
	pieces: ReadonlyArray<TokenizedPiece>,
	lexicon: GazetteerLexicon
): { features: number[][]; confidence: number[] } {
	const charBits = gazetteerCharPaint(text, lexicon)
	const zero = () => new Array<number>(lexicon.featureDim).fill(0)
	const features: number[][] = []
	const confidence: number[] = []

	for (const p of pieces) {
		let bits = 0

		for (let c = p.start; c < p.end; c++) {
			if (c < text.length && !/\s/.test(text[c]!)) {
				bits = charBits[c]!
				break
			}
		}
		features.push(bits ? bitsToRow(bits, lexicon) : zero())
		confidence.push(bits ? 1.0 : 0)
	}

	return { features, confidence }
}
