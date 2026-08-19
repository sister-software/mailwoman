/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Can the tokenizer REPRESENT this input at all?
 *
 *   A parse defect on a non-Latin locale has two very different causes that look identical from the outside: the corpus
 *   never taught the format, or the vocabulary cannot express the string and the model is learning a byte sequence
 *   instead of a word. Proposing corpus rows for the second is working against the representation, and nothing in a
 *   trace says which one you are looking at — the trace shows pieces, and `<0xC6>` reads as noise rather than as the
 *   finding.
 *
 *   SentencePiece marks exactly what it could not represent by falling back to raw UTF-8 bytes, so the question is one
 *   measurement. The worked example is Vietnamese (#1744): `Đường` — the word that marks a street, the way `Street`
 *   does in English — encodes as `Đ|<0xC6>|<0xB0>|<0xE1>|<0xBB>|<0x9D>|ng`, five raw bytes through the middle, so no
 *   piece in the vocabulary means `Đường` and no corpus can teach it as a unit. On five VN addresses (204 characters)
 *   against the en-us tokenizer, 40.6% of pieces were byte fallbacks and 0.94 pieces fell per character, against 3.7%
 *   and 0.41 for the same addresses transliterated.
 *
 *   BOTH FIGURES MOVE WITH THE SAMPLE, which is the reason `control` exists rather than a remembered threshold — a
 *   two-line probe of the same language measures 34.4%, and neither number means anything except beside its arm.
 *
 *   A RATE ALONE IS NOT A FINDING either, which is why the per-character report is not optional. Vietnamese is not
 *   missing from the vocabulary — `Đ`, `ạ`, `ô`, `ă`, `ê` are all present. What is missing, across that five-address
 *   sample, is twelve characters, every one a vowel carrying TWO marks (`ư ầ ậ ế ễ ệ ố ồ ộ ờ ợ ừ`); a smaller sample
 *   names a subset of the same set. "Add Vietnamese" and "add these codepoints" are different decisions, and only the
 *   second is one somebody can price.
 *
 *   Normalization form does not matter here and the tool does not offer it as a knob: SentencePiece normalizes
 *   internally, and NFC and NFD were measured to give byte-identical piece counts on the same string.
 */

import { readFileSync } from "node:fs"

/**
 * SentencePiece renders a byte it cannot represent as `<0xNN>`. This is the whole measurement — everything else is
 * aggregation over it.
 */
const BYTE_PIECE = /^<0x[0-9A-Fa-f]{2}>$/

export interface VocabularyLine {
	text: string
	pieces: number
	characters: number
	byteFallbacks: number
	/**
	 * Pieces per character. Latin text against this tokenizer runs around 0.4; a figure near or above 1.0 means the
	 * string is being spelled out rather than tokenized.
	 */
	piecesPerCharacter: number
	/**
	 * The piece sequence, joined by `|`. Present only when asked for — it is the part that shows WHERE a word shatters,
	 * and the part that makes a reply long.
	 */
	sequence?: string
}

export interface VocabularyReport {
	tokenizerPath: string
	lines: VocabularyLine[]
	totals: {
		pieces: number
		characters: number
		byteFallbacks: number
		piecesPerCharacter: number
		/**
		 * Byte fallbacks as a share of pieces. The headline number, and meaningless without a comparison arm — pass
		 * `control` so the reply carries one.
		 */
		byteFallbackShare: number
	}
	control?: VocabularyReport["totals"]
	/**
	 * Per-character coverage over every letter in the input. The actionable half: a list of codepoints is a decision, a
	 * percentage is not.
	 */
	characters?: {
		inVocabulary: string[]
		byteFallback: string[]
	}
}

interface Tokenizer {
	encode: (text: string) => { pieces: Array<{ piece: string }> }
}

function measureLine(tokenizer: Tokenizer, text: string, withSequence: boolean): VocabularyLine {
	const pieces = tokenizer.encode(text).pieces.map((p) => p.piece)
	const characters = [...text].length

	return {
		text,
		pieces: pieces.length,
		characters,
		byteFallbacks: pieces.filter((p) => BYTE_PIECE.test(p)).length,
		piecesPerCharacter: characters ? pieces.length / characters : 0,
		...(withSequence ? { sequence: pieces.join("|") } : {}),
	}
}

function total(lines: readonly VocabularyLine[]): VocabularyReport["totals"] {
	const pieces = lines.reduce((s, l) => s + l.pieces, 0)
	const characters = lines.reduce((s, l) => s + l.characters, 0)
	const byteFallbacks = lines.reduce((s, l) => s + l.byteFallbacks, 0)

	return {
		pieces,
		characters,
		byteFallbacks,
		piecesPerCharacter: characters ? pieces / characters : 0,
		byteFallbackShare: pieces ? byteFallbacks / pieces : 0,
	}
}

/**
 * Which letters in `texts` the vocabulary can express on their own.
 *
 * Judged one character at a time on purpose. A character that falls back inside a word might merely be an unlucky
 * segmentation; a character that falls back ALONE is absent from the vocabulary, which is the fact a vocabulary
 * decision needs.
 */
function characterCoverage(
	tokenizer: Tokenizer,
	texts: readonly string[]
): NonNullable<VocabularyReport["characters"]> {
	const letters = [...new Set(texts.join(""))].filter((c) => /\p{L}/u.test(c)).toSorted()
	const inVocabulary: string[] = []
	const byteFallback: string[] = []

	for (const letter of letters) {
		const pieces = tokenizer.encode(letter).pieces.map((p) => p.piece)

		if (pieces.some((p) => BYTE_PIECE.test(p))) {
			byteFallback.push(letter)
		} else {
			inVocabulary.push(letter)
		}
	}

	return { inVocabulary, byteFallback }
}

export interface VocabularyOptions {
	texts: readonly string[]
	/**
	 * A comparison arm — the same content the tokenizer handles well, usually the same addresses transliterated. Without
	 * one a fallback share is a number with nothing to be high or low against.
	 */
	control?: readonly string[]
	tokenizerPath?: string
	locale?: string
	sequences?: boolean
	perCharacter?: boolean
}

/**
 * Measure vocabulary coverage. The tokenizer is resolved through `resolveWeights` like every other consumer, so the
 * answer describes the tokenizer the runtime would actually load rather than a file someone typed a path to.
 */
export async function runVocabulary(options: VocabularyOptions): Promise<VocabularyReport> {
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")

	let tokenizerPath = options.tokenizerPath

	if (!tokenizerPath) {
		const { resolveWeights } = await import("@mailwoman/neural/weights")

		tokenizerPath = resolveWeights({ locale: options.locale ?? "en-us" }).tokenizerPath
	}

	const tokenizer = (await MailwomanTokenizer.loadFromFile(tokenizerPath)) as unknown as Tokenizer

	const lines = options.texts.map((text) => measureLine(tokenizer, text, options.sequences ?? false))

	return {
		tokenizerPath,
		lines,
		totals: total(lines),
		...(options.control?.length
			? { control: total(options.control.map((text) => measureLine(tokenizer, text, false))) }
			: {}),
		...((options.perCharacter ?? true) ? { characters: characterCoverage(tokenizer, options.texts) } : {}),
	}
}

/**
 * Read newline-delimited inputs from a file, for a sweep bigger than an argument list.
 */
export function readVocabularyInputs(path: string): string[] {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a hand-written probe list, read whole and bounded
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
}

/**
 * Internals reached by the unit tests, which drive a stub tokenizer rather than loading the real 9 MB model.
 */
export const __testing = { characterCoverage, measureLine, total }
