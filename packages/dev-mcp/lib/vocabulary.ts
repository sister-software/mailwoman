/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Whether the tokenizer can represent an input at all: SentencePiece marks what it cannot represent by falling back
 * to raw UTF-8 bytes, and the per-character report is required because a fallback share has no meaning without a
 * control arm.
 */

/**
 * SentencePiece renders a byte it cannot represent as `<0xNN>`; this is the whole
 * measurement and everything else is aggregation over it.
 */
const BYTE_PIECE = /^<0x[0-9A-Fa-f]{2}>$/

interface VocabularyLine {
	text: string
	pieces: number
	characters: number
	byteFallbacks: number
	/**
	 * Pieces per character; Latin text against this tokenizer runs around 0.4, and a figure near
	 * or above 1.0 means the string is being spelled out rather than tokenized.
	 */
	piecesPerCharacter: number
	/**
	 * The piece sequence, joined by `|`, present only when asked for; it shows
	 * where a word shatters and is what makes a reply long.
	 */
	sequence?: string
}

/**
 * Vocabulary coverage for a set of inputs, with an optional control arm and per-character coverage.
 */
export interface VocabularyReport {
	tokenizerPath: string
	lines: VocabularyLine[]
	totals: {
		pieces: number
		characters: number
		byteFallbacks: number
		piecesPerCharacter: number
		/**
		 * Byte fallbacks as a share of pieces; the headline number is meaningless without
		 * a comparison arm, so pass `control` so the reply carries one.
		 */
		byteFallbackShare: number
	}
	control?: VocabularyReport["totals"]
	/**
	 * Per-character coverage over every letter in the input, the actionable half:
	 * a list of codepoints is a decision, a percentage is not.
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
 * Which letters in `texts` the vocabulary can express on their own, judged one character at
 * a time: a character that falls back inside a word might merely be an unlucky segmentation,
 * while one that falls back alone is absent from the vocabulary.
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

/**
 * Inputs for {@link runVocabulary}, including the optional comparison arm.
 */
export interface VocabularyOptions {
	texts: readonly string[]
	/**
	 * A comparison arm — the same content the tokenizer handles well, usually the same addresses
	 * transliterated — without which a fallback share is a number with no comparison arm to be high or low against.
	 */
	control?: readonly string[]
	tokenizerPath?: string
	locale?: string
	sequences?: boolean
	perCharacter?: boolean
}

/**
 * Measure vocabulary coverage; the tokenizer is resolved through `resolveWeights`
 * like every other consumer, so the answer describes the tokenizer the runtime would
 * actually load rather than a file someone typed a path to.
 */
export async function runVocabulary(options: VocabularyOptions): Promise<VocabularyReport> {
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")

	let tokenizerPath = options.tokenizerPath

	if (!tokenizerPath) {
		const { resolveWeights } = await import("@mailwoman/neural/weights")

		tokenizerPath = (await resolveWeights({ locale: options.locale ?? "en-us" })).tokenizerPath
	}

	const tokenizer: Tokenizer = await MailwomanTokenizer.loadFromFile(tokenizerPath)

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
 * Internals reached by the unit tests, which drive a stub tokenizer rather than loading the real 9 MB model.
 */
export const __testing = { characterCoverage, measureLine, total }
