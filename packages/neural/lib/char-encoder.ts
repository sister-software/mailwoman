import { stringifyJSON } from "@mailwoman/core/json"

import { familyFallbackFor } from "#weights/families"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The character encoder for char-path models. It uses one unit per Unicode code point rather than per
 *   UTF-16 unit, matching Python's treatment of astral characters. The classifier imports this module
 *   into the browser bundle, so it reaches no `node:` module.
 */

/**
 * The padding id, fixed at 0 by the trainer's `build_char_vocab`, which writes `<pad>` first.
 */
export const PAD_CHAR_ID = 0

/**
 * The unknown id, fixed at 1 by `build_char_vocab`, which writes `<unk>` second
 * so every real character follows in code-point order.
 */
export const UNK_CHAR_ID = 1

/**
 * A sealed character vocabulary mapping code point to id, the `char-vocab-*.json` artifact verbatim.
 */
export type CharVocabulary = ReadonlyMap<string, number>

export interface CharEncoderInterface {
	/**
	 * S — the unit count every row is truncated or padded to (the training config's `max_units`).
	 */
	maxUnits: number
	/**
	 * W — slots per unit (`max_unit_width`); the unit's own code point plus `ctxChars` on each side.
	 */
	maxUnitWidth: number
	ctxChars: number
}

export interface CharUnit {
	/**
	 * The unit's text — one code point in char mode.
	 */
	text: string
	/**
	 * UTF-16 offsets into the original string, so a decoded span can be read back out of the input as typed.
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
 * Encodes one string under the interface, with every real unit one code point of `raw`
 * and only the first S kept.
 */
export function encodeCharUnits(
	raw: string,
	vocabulary: CharVocabulary,
	encoderInterface: CharEncoderInterface
): CharEncoding {
	const { maxUnits, maxUnitWidth, ctxChars } = encoderInterface
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
 * Validates a parsed `char-vocab-*.json` into a vocabulary, refusing anything
 * but a flat `{ character: integer }` map with the reserved ids in place
 * because a malformed vocabulary encodes every character as UNK.
 */
export function parseCharVocabulary(parsed: unknown, source: string): CharVocabulary {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError(`char vocabulary ${source}: expected a { character: id } map`)
	}

	const vocabulary = new Map<string, number>()

	for (const [character, id] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof id !== "number" || !Number.isInteger(id)) {
			throw new TypeError(`char vocabulary ${source}: entry ${stringifyJSON(character)} has a non-integer id`)
		}

		vocabulary.set(character, id)
	}

	if (vocabulary.get("<pad>") !== PAD_CHAR_ID || vocabulary.get("<unk>") !== UNK_CHAR_ID) {
		throw new TypeError(`char vocabulary ${source}: <pad> must be ${PAD_CHAR_ID} and <unk> ${UNK_CHAR_ID}`)
	}

	return vocabulary
}

/**
 * How a weights package turns text into model input, absent from a card meaning SentencePiece.
 */
export type EncoderDescriptor =
	| { kind: "sentencepiece" }
	| {
			kind: "char"
			/**
			 * The sealed character vocabulary sibling's file name, relative to the
			 * package directory (`char-vocab.json`).
			 */
			charVocab: string
			maxUnits: number
			maxUnitWidth: number
			ctxChars: number
	  }

/**
 * Reads a parsed card's `encoder` block, refusing a char card that omits the
 * vocabulary sibling or the `(S, W, ctx)` interface rather than defaulting a value
 * that would encode every row differently from training.
 */
export function encoderDescriptorFromCard(
	card: Record<string, unknown> | undefined,
	source: string
): EncoderDescriptor {
	const encoder = card?.encoder

	if (encoder === undefined || encoder === "sentencepiece") return { kind: "sentencepiece" }

	if (encoder !== "char") {
		throw new Error(`model-card at ${source} declares an unknown \`encoder\` ${stringifyJSON(encoder)}`)
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
 * Returns the base package a locale falls back to when it has no package of its own —
 * the CJK char-path base for Japanese, Chinese and Korean — delegating to
 * `#weights/families` so the language set has one home.
 */
export function scriptFamilyBase(locale: string): string | undefined {
	return familyFallbackFor(locale)
}
