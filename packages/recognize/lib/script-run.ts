// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The scripts and classes of tokens under the `postal` generation of the query shape.
 *
 *   The `structure` family splits a text into tokens and segments.
 *   Its engine classifies each token with hand-written ranges for ten scripts.
 *
 *   This module classifies each token again from the Unicode Script property, through
 *   `unicodeScriptOf` of `@mailwoman/registry`, so every script the registry knows has an answer.
 *
 *   # The rule for Common and Inherited code points
 *
 *   The rule follows UAX #24, section 5.
 *   A Common code point (digits, punctuation, symbols) belongs to no script and counts toward none.
 *
 *   An Inherited code point (a combining mark) takes the script of the code point
 *   before it, and counts toward that script.
 *   An Inherited code point at the start of a token has no code point before it and counts toward none.
 *
 *   Where the script of the code point before it is Common, the Inherited one counts toward none.
 *   The rule reads one token or one text at a time, so the code point
 *   before an Inherited one never lies outside it.
 *
 *   A default-ignorable code point, such as U+200B ZERO WIDTH SPACE, is no part of a token's
 *   text: a token starts after the ones that lead it and ends before the ones that trail it,
 *   and one inside a token counts toward no script and no class.
 *   Offsets still refer to the original text.
 *
 *   # The order of a tie
 *
 *   Two scripts with equal counts rank by the earlier first code point, then by the
 *   longer unbroken run of the script, then by the code in ISO order.
 *   One comparator ranks the scripts of a token and the scripts of a text.
 *
 *   # The class of a token
 *
 *   A token is `cjk` when one of its letters is Han, Hiragana, Katakana, Hangul, Bopomofo
 *   or Yi, `cyrillic` when one is Cyrillic, and `arabic` when one is Arabic, in that order.
 *   Otherwise it is `mixed` when it holds a decimal digit and a letter, `digit`
 *   or `alpha` when it holds one of them, and `mixed` when it holds neither.
 *
 *   A letter is any code point of the Unicode letter and mark categories,
 *   in any script, so `Αθήνα` is `alpha`.
 *   A fullwidth Latin letter is Latin, so `ＡＢＣ` is `alpha`.
 */

import { unicodeScriptOf } from "@mailwoman/registry/iso15924/unicode-script"
import type { BCP47 } from "@mailwoman/registry/types"

import type { CharacterClass, ScriptShare, StructureFields, TextSpan, TokenCharacterClass, TokenClass } from "#types"

const CJK_SCRIPTS: ReadonlySet<string> = new Set(["Hani", "Hira", "Kana", "Hang", "Bopo", "Yiii"])

const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u
const LETTER = /^[\p{L}\p{M}]$/u
const DECIMAL = /^\p{Nd}$/u

/**
 * One script's tally in a text.
 */
interface ScriptTally {
	readonly script: BCP47.ScriptCode
	count: number
	/**
	 * The offset of the first code point of the script, in UTF-16 code units.
	 */
	readonly first: number
	/**
	 * The longest unbroken run of the script, in code points.
	 */
	longest: number
	/**
	 * The run in progress, in code points.
	 */
	run: number
}

/**
 * What one pass over a text finds in it.
 */
export interface ScriptScan {
	readonly tallies: ReadonlyMap<BCP47.ScriptCode, ScriptTally>
	readonly digit: boolean
	readonly letter: boolean
	readonly cjk: boolean
	readonly cyrillic: boolean
	readonly arabic: boolean
}

function isAscii(codePoint: number): boolean {
	return codePoint < 0x80
}

/**
 * Reads the scripts and the class flags of `text`, by the rule in the module's documentation.
 *
 * @param base The offset of `text` in the text it was taken from, so a tie
 * reads the first offset in that text.
 */
export function scanScripts(text: string, base = 0): ScriptScan {
	const tallies = new Map<BCP47.ScriptCode, ScriptTally>()
	let digit = false
	let letter = false
	let cjk = false
	let cyrillic = false
	let arabic = false
	let previous: BCP47.ScriptCode | null = null
	let current: ScriptTally | null = null

	for (let index = 0; index < text.length;) {
		const codePoint = text.codePointAt(index)!
		const width = codePoint > 0xff_ff ? 2 : 1
		const at = base + index

		index += width

		const character = isAscii(codePoint) || codePoint > 0xff_ff ? String.fromCodePoint(codePoint) : text[index - 1]!

		if (!isAscii(codePoint) && IGNORABLE.test(character)) continue

		let script = unicodeScriptOf(codePoint)

		// UAX #24: an Inherited code point takes the script of the one before it.
		if (script === "Zinh") {
			script = previous ?? ("Zyyy" as BCP47.ScriptCode)
		}

		previous = script

		const ascii = isAscii(codePoint)
		const isDigit = ascii ? codePoint >= 0x30 && codePoint <= 0x39 : DECIMAL.test(character)
		const isLetter = ascii ? (codePoint | 0x20) >= 0x61 && (codePoint | 0x20) <= 0x7a : LETTER.test(character)

		if (isDigit) {
			digit = true
		}

		if (isLetter) {
			letter = true

			if (CJK_SCRIPTS.has(script)) {
				cjk = true
			} else if (script === "Cyrl") {
				cyrillic = true
			} else if (script === "Arab") {
				arabic = true
			}
		}

		if (script === "Zyyy") {
			current = null

			continue
		}

		let tally = tallies.get(script)

		if (!tally) {
			tally = { script, count: 0, first: at, longest: 0, run: 0 }
			tallies.set(script, tally)
		}

		tally.count++

		if (current === tally) {
			tally.run++
		} else {
			tally.run = 1
			current = tally
		}

		if (tally.run > tally.longest) {
			tally.longest = tally.run
		}
	}

	return { tallies, digit, letter, cjk, cyrillic, arabic }
}

function compareTallies(left: ScriptTally, right: ScriptTally): number {
	return (
		right.count - left.count ||
		left.first - right.first ||
		right.longest - left.longest ||
		(left.script < right.script ? -1 : left.script > right.script ? 1 : 0)
	)
}

/**
 * The script that most code points of the scan belong to, or `Zyyy` when none belongs to a script.
 */
export function dominantScript(scan: ScriptScan): BCP47.ScriptCode {
	let best: ScriptTally | null = null

	for (const tally of scan.tallies.values()) {
		if (!best || compareTallies(tally, best) < 0) {
			best = tally
		}
	}

	return best ? best.script : ("Zyyy" as BCP47.ScriptCode)
}

/**
 * The class of a token from what its scan found.
 */
export function classOfScan(scan: ScriptScan): TokenCharacterClass {
	if (scan.cjk) return "cjk"

	if (scan.cyrillic) return "cyrillic"

	if (scan.arabic) return "arabic"

	if (scan.digit && scan.letter) return "mixed"

	if (scan.digit) return "digit"

	if (scan.letter) return "alpha"

	return "mixed"
}

/**
 * The script of a string, as the `postal` generation reads a token's script.
 *
 * A string with no letter and no script mark, such as `2024`, is `Zyyy`.
 */
export function scriptOfText(text: string): BCP47.ScriptCode {
	return dominantScript(scanScripts(text))
}

/**
 * Folds the class of every token to the class of the whole text.
 *
 * `cjk`, `cyrillic` and `arabic` stand for a text that holds only that class,
 * `mixed` for one that holds one of them beside another class, `alphanumeric` for a text
 * with a mixed token or both digits and letters, and so on, as the legacy fold did.
 */
export function foldTokenClasses(classes: Iterable<TokenCharacterClass>): CharacterClass {
	let digit = 0
	let alpha = 0
	let mixed = 0
	let cjk = 0
	let cyrillic = 0
	let arabic = 0

	for (const tokenClass of classes) {
		if (tokenClass === "digit") {
			digit++
		} else if (tokenClass === "alpha") {
			alpha++
		} else if (tokenClass === "mixed") {
			mixed++
		} else if (tokenClass === "cjk") {
			cjk++
		} else if (tokenClass === "cyrillic") {
			cyrillic++
		} else if (tokenClass === "arabic") {
			arabic++
		}
	}

	if (cjk && !alpha && !cyrillic && !arabic) return "cjk"

	if (cyrillic && !alpha && !cjk && !arabic) return "cyrillic"

	if (arabic && !alpha && !cjk && !cyrillic) return "arabic"

	if (cjk || cyrillic || arabic) return "mixed"

	if (mixed || (digit && alpha)) return "alphanumeric"

	if (digit && !alpha) return "numeric"

	if (alpha && !digit) return "alpha"

	return "mixed"
}

/**
 * The script of the tokens that overlap the half-open range `[start, end)`,
 * ranked as the module's documentation states.
 *
 * Each token counts by its length in UTF-16 code units, and a `Zyyy` token counts for none.
 * A tie goes to the script of the earlier token, then to the script with the
 * longer token, then to the earlier code.
 * A range with only `Zyyy` tokens returns `Zyyy`.
 */
export function scriptOfRange(
	tokens: ReadonlyArray<Pick<TokenClass, "span" | "script">>,
	start: number,
	end: number
): BCP47.ScriptCode {
	const weights = new Map<BCP47.ScriptCode, { weight: number; first: number; longest: number }>()

	for (const { span, script } of tokens) {
		if (span.end <= start || span.start >= end || (script as string) === "Zyyy") continue

		const length = span.end - span.start
		const known = weights.get(script)

		if (known) {
			known.weight += length
			known.longest = Math.max(known.longest, length)
		} else {
			weights.set(script, { weight: length, first: span.start, longest: length })
		}
	}

	let best: BCP47.ScriptCode = "Zyyy" as BCP47.ScriptCode
	let bestEntry: { weight: number; first: number; longest: number } | null = null

	for (const [script, entry] of weights) {
		const wins =
			!bestEntry ||
			entry.weight - bestEntry.weight > 0 ||
			(entry.weight === bestEntry.weight &&
				(entry.first < bestEntry.first ||
					(entry.first === bestEntry.first &&
						(entry.longest > bestEntry.longest || (entry.longest === bestEntry.longest && script < best)))))

		if (wins) {
			best = script
			bestEntry = entry
		}
	}

	return best
}

/**
 * The structural fields that the `postal` generation corrects: the token classes,
 * the scripts and the character class.
 */
export type SpecifiedStructure = Omit<StructureFields, "regionAbbreviations">

/**
 * Reads the tokens, scripts and character class of a text again from the Unicode Script property.
 *
 * `fields` is the output of a recognizer that composes `structure`, and `text` is the text it read.
 * The segments pass through with a fresh span object each, and a token that holds
 * only default-ignorable code points leaves the list.
 *
 * The text's scripts are ranked by share, then by the order of a tie in the module's documentation.
 */
export function specifyStructure(fields: StructureFields, text: string): SpecifiedStructure {
	const tokenClasses: TokenClass[] = []
	const totals = new Map<BCP47.ScriptCode, ScriptTally>()
	let total = 0

	for (const token of fields.tokenClasses) {
		let { start, end } = token.span

		while (start < end && IGNORABLE.test(text[start]!) && !isAscii(text.charCodeAt(start))) {
			start++
		}

		while (end > start && IGNORABLE.test(text[end - 1]!) && !isAscii(text.charCodeAt(end - 1))) {
			end--
		}

		if (start === end) continue

		const body = text.slice(start, end)
		const scan = scanScripts(body, start)
		const span: TextSpan = { start, end, body }

		tokenClasses.push({ span, class: classOfScan(scan), script: dominantScript(scan) })

		for (const tally of scan.tallies.values()) {
			const known = totals.get(tally.script)

			total += tally.count

			if (known) {
				known.count += tally.count
				known.longest = Math.max(known.longest, tally.longest)
			} else {
				totals.set(tally.script, { ...tally })
			}
		}
	}

	const scripts: ScriptShare[] = [...totals.values()]
		.toSorted(compareTallies)
		.map((tally) => ({ script: tally.script, share: tally.count / total }))

	return {
		characterClass: tokenClasses.length
			? foldTokenClasses(tokenClasses.map(({ class: tokenClass }) => tokenClass))
			: "alpha",
		scripts,
		tokenClasses,
		segments: fields.segments.map((segment) => ({ ...segment, span: { ...segment.span } })),
		totalLength: fields.totalLength,
	}
}
