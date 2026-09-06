/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The character encoder for char-path models — the runtime twin of `encode_row_units` in
 *   `corpus-python/src/mailwoman_train/char_tokenizer.py`, under the same contract (D1): one UNIT per Unicode code point,
 *   `char_ids (S, W)` where slot `j` of unit `[b, e)` is the code point at `b - ctx + j`, PAD outside the string or at
 *   and past `e + ctx`, UNK for a code point the sealed vocabulary lacks; the row truncated to S units and padded with
 *   all-PAD unit rows carrying attention 0. A CJK model never meets SentencePiece: this is its whole tokenizer.
 *
 *   Code points, not UTF-16 units. Python indexes `str` by code point, so an astral character (𠮷) is one unit there
 *   and must be one unit here; iterating the string with `Array.from` is what keeps the two encoders producing the same
 *   `char_ids` for the same text, which `test/unit/char-encoder.test.ts` pins against a fixture the Python side wrote.
 *
 *   This module is on the browser bundle (the classifier imports it), so it reaches no `node:` module: the vocabulary
 *   file is read by the node-only loader and validated here.
 */

/**
 * The padding id: every slot outside the string or the unit's window, and every all-padding unit row. Fixed at 0 by the
 * trainer's `build_char_vocab`, which writes `<pad>` first.
 */
export const PAD_CHAR_ID = 0

/**
 * The unknown id: a code point the sealed vocabulary lacks. Fixed at 1 by `build_char_vocab`, which writes `<unk>`
 * second; every real character follows in code-point order.
 */
export const UNK_CHAR_ID = 1

/**
 * A sealed character vocabulary: code point → id. The JSON artifact (`char-vocab-*.json`) is this map verbatim.
 */
export type CharVocabulary = ReadonlyMap<string, number>

export interface CharEncoderContract {
	/**
	 * S — the unit count every row is truncated or padded to (the training config's `max_units`).
	 */
	maxUnits: number
	/**
	 * W — slots per unit (`max_unit_width`); the unit's own code point plus `ctxChars` on each side.
	 */
	maxUnitWidth: number
	/**
	 * Context code points on each side of the unit (`char_ctx`).
	 */
	ctxChars: number
}

export interface CharUnit {
	/**
	 * The unit's text — one code point in char mode.
	 */
	text: string
	/**
	 * UTF-16 offsets into the original string, so a decoded span can be sliced from the input as typed.
	 */
	start: number
	end: number
}

export interface CharEncoding {
	/**
	 * `(S, W)` code-point ids, row-major, padded to S.
	 */
	charIDs: number[][]
	/**
	 * `(S)` — 1 for a real unit, 0 for padding.
	 */
	attentionMask: number[]
	/**
	 * The real units, in order — the token list the decoder receives (length ≤ S).
	 */
	units: CharUnit[]
}

/**
 * Encode one string under the contract. Every real unit is one code point of `raw`; the first S of them are kept.
 */
export function encodeCharUnits(raw: string, vocabulary: CharVocabulary, contract: CharEncoderContract): CharEncoding {
	const { maxUnits, maxUnitWidth, ctxChars } = contract
	const codePoints = Array.from(raw)
	const kept = codePoints.slice(0, maxUnits)
	const charIDs: number[][] = []
	const units: CharUnit[] = []
	let offset = 0

	for (const [index, codePoint] of kept.entries()) {
		const row: number[] = []

		for (let slot = 0; slot < maxUnitWidth; slot++) {
			const position = index - ctxChars + slot

			if (position >= 0 && position < codePoints.length && position < index + 1 + ctxChars) {
				row.push(vocabulary.get(codePoints[position]!) ?? UNK_CHAR_ID)
			} else {
				row.push(PAD_CHAR_ID)
			}
		}

		charIDs.push(row)
		units.push({ text: codePoint, start: offset, end: offset + codePoint.length })
		offset += codePoint.length
	}

	const attentionMask = new Array<number>(charIDs.length).fill(1)

	while (charIDs.length < maxUnits) {
		charIDs.push(new Array<number>(maxUnitWidth).fill(PAD_CHAR_ID))
		attentionMask.push(0)
	}

	return { charIDs, attentionMask, units }
}

/**
 * Validate a parsed `char-vocab-*.json` artifact into a vocabulary. Refuses anything that is not a flat `{ character:
 * integer }` map with the reserved ids in place, because a malformed vocabulary would encode every character as UNK and
 * the model would answer confidently on nothing. Pure: the file read lives on the node-only loader, so this module
 * stays on the browser graph without a `node:` reach (#2168).
 */
export function parseCharVocabulary(parsed: unknown, source: string): CharVocabulary {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError(`char vocabulary ${source}: expected a { character: id } map`)
	}

	const vocabulary = new Map<string, number>()

	for (const [character, id] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof id !== "number" || !Number.isInteger(id)) {
			throw new TypeError(`char vocabulary ${source}: entry ${JSON.stringify(character)} has a non-integer id`)
		}

		vocabulary.set(character, id)
	}

	if (vocabulary.get("<pad>") !== PAD_CHAR_ID || vocabulary.get("<unk>") !== UNK_CHAR_ID) {
		throw new TypeError(`char vocabulary ${source}: <pad> must be ${PAD_CHAR_ID} and <unk> ${UNK_CHAR_ID}`)
	}

	return vocabulary
}

/**
 * How a weights package turns text into model input. Absent from a card means SentencePiece — every Latin bundle
 * shipped before the char path existed says nothing here.
 */
export type EncoderDescriptor =
	| { kind: "sentencepiece" }
	| {
			kind: "char"
			/**
			 * The sealed character vocabulary sibling's file name, relative to the package directory (`char-vocab.json`).
			 */
			charVocab: string
			maxUnits: number
			maxUnitWidth: number
			ctxChars: number
	  }

/**
 * Read a parsed card's `encoder` block (#2164). A char card names its vocabulary sibling and the `(S, W, ctx)` contract
 * the model was trained under; a runtime that guessed any of the three would encode every row differently from training
 * and score confidently on garbage, so a char card missing one of them is refused rather than defaulted. Pure, so the
 * browser loader reads it from a fetched card and the node loader from a file.
 */
export function encoderDescriptorFromCard(
	card: Record<string, unknown> | undefined,
	source: string
): EncoderDescriptor {
	const encoder = card?.encoder

	if (encoder === undefined || encoder === "sentencepiece") return { kind: "sentencepiece" }

	if (encoder !== "char") {
		throw new Error(`model-card at ${source} declares an unknown \`encoder\` ${JSON.stringify(encoder)}`)
	}

	const charVocab = card?.char_vocab
	const maxUnits = card?.max_units
	const maxUnitWidth = card?.max_unit_width
	const ctxChars = card?.char_ctx

	if (
		typeof charVocab !== "string" ||
		!charVocab ||
		!Number.isInteger(maxUnits) ||
		!Number.isInteger(maxUnitWidth) ||
		!Number.isInteger(ctxChars)
	) {
		throw new Error(
			`model-card at ${source} declares \`encoder: "char"\` but not all of char_vocab (string), ` +
				`max_units, max_unit_width and char_ctx (integers) — the char path cannot encode without them`
		)
	}

	return {
		kind: "char",
		charVocab,
		maxUnits: maxUnits as number,
		maxUnitWidth: maxUnitWidth as number,
		ctxChars: ctxChars as number,
	}
}

/**
 * The base package a locale falls back to when it has no package of its own: the CJK char-path base for Japanese,
 * Chinese and Korean (#2164). Latin locales have no family base — `en-us` IS the Latin base, and the overlays name it
 * through `mailwoman.baseWeights` instead.
 */
export function scriptFamilyBase(locale: string): string | undefined {
	const language = locale.toLowerCase().split("-")[0]

	return language === "ja" || language === "zh" || language === "ko" ? "cjk" : undefined
}
