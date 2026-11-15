// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   ISO 15924 script codes, read from the script subtags of the IANA Language Subtag Registry.
 *
 *   An import of this module retains the 225-row script table and no language or region row.
 */

import { scriptSubtagRows } from "#artifacts/bcp47/script"
import { lazySubtagIndex } from "#bcp47/subtag-index"
import { type Parsed, ParseFailure } from "#errors"
import type { BCP47 } from "#types"

const index = lazySubtagIndex(scriptSubtagRows)

const CANONICAL = /^[A-Z][a-z]{3}$/
const LETTERS = /^[A-Za-z]{4}$/

/**
 * One script as the registry describes it.
 */
export interface ScriptRecord {
	code: BCP47.ScriptCode
	/**
	 * The registry's first description, such as `Japanese (alias for Han + Hiragana + Katakana)`.
	 */
	name: string
	descriptions: readonly string[]
	/**
	 * The date the registry deprecated the code, or `null`.
	 */
	deprecated: string | null
}

/**
 * Whether `input` is a script code the registry holds, in its canonical title case.
 *
 * `Latn` and `Jpan` are.
 * `latn`, `LATN` and `Latin` are not.
 */
export function isScriptCode(input: string): input is BCP47.ScriptCode {
	return CANONICAL.test(input) && index().get(input) !== null
}

/**
 * The branded script code, or the reason the input was refused.
 */
export function parseScriptCode(input: string): Parsed<BCP47.ScriptCode> {
	if (!LETTERS.test(input)) return { ok: false, reason: ParseFailure.Shape, input }

	if (!CANONICAL.test(input)) return { ok: false, reason: ParseFailure.Case, input }

	if (!isScriptCode(input)) return { ok: false, reason: ParseFailure.NotFound, input }

	return { ok: true, value: input }
}

/**
 * The record of a canonical script code, or `null`.
 */
export function getScript(code: string): ScriptRecord | null {
	if (!CANONICAL.test(code)) return null

	const row = index().get(code)

	if (!row) return null

	return {
		code: code as BCP47.ScriptCode,
		name: row.descriptions[0] ?? code,
		descriptions: row.descriptions,
		deprecated: row.deprecated ?? null,
	}
}

/**
 * ISO 15924 codes that name a combination or a variant of Unicode scripts, mapped to the
 * Unicode Script property values (short aliases) whose characters they cover.
 *
 * Unicode encodes the characters of a variant code, such as Fraktur `Latf`, under the base script.
 * A combined code, such as Japanese `Jpan`, covers several scripts at once.
 */
const UNICODE_SCRIPT_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
	Jpan: ["Hani", "Hira", "Kana"],
	Kore: ["Hang", "Hani"],
	Hans: ["Hani"],
	Hant: ["Hani"],
	Hanb: ["Hani", "Bopo"],
	Hrkt: ["Hira", "Kana"],
	Latf: ["Latn"],
	Latg: ["Latn"],
	Aran: ["Arab"],
	Cyrs: ["Cyrl"],
	Syre: ["Syrc"],
	Syrj: ["Syrc"],
	Syrn: ["Syrc"],
	Geok: ["Geor"],
}

function isUnicodeScriptValue(code: string): boolean {
	try {
		new RegExp(`\\p{Script=${code}}`, "u")

		return true
	} catch {
		return false
	}
}

/**
 * The Unicode Script property values whose characters a script code covers.
 *
 * `Jpan` gives `Hani`, `Hira` and `Kana`, and `Latn` gives `Latn`.
 * A code with no Unicode script of its own, such as `Zmth` (mathematical notation)
 * or a private-use code, gives an empty list.
 *
 * The runtime's regular-expression engine decides which values it knows.
 */
export function unicodeScriptsOf(code: BCP47.ScriptCode): readonly string[] {
	const expanded = UNICODE_SCRIPT_EXPANSIONS[code]

	if (expanded) return expanded

	return isUnicodeScriptValue(code) ? [code] : []
}

/**
 * Whether every letter in `text` belongs to one of the scripts the code covers.
 *
 * Digits, punctuation, spaces and other non-letters are ignored, so `ニューヨーク州 10001` is written in `Jpan`.
 * A text without letters returns `false`, because it shows no script at all.
 *
 * Common and Inherited letters, such as the prolonged sound mark `ー` in `ニューヨーク`,
 * are accepted beside any script and don't count as evidence of one.
 *
 * Letters of an `alsoAccepted` script pass without counting, so `金龍酒家, 12 Gerrard Street`
 * is written in `Latn` when `Hani` is also accepted: the Latin letters make up
 * the address, and the Han name sits inside it.
 */
export function isWrittenInScript(
	text: string,
	code: BCP47.ScriptCode,
	alsoAccepted: readonly BCP47.ScriptCode[] = []
): boolean {
	const scripts = unicodeScriptsOf(code)

	if (!scripts.length) return false

	const own = scriptClass(scripts)
	const accepted = scriptClass([...alsoAccepted.flatMap(unicodeScriptsOf), "Zyyy", "Zinh"])
	let letters = 0

	for (const character of text) {
		if (!/\p{L}|\p{M}/u.test(character)) continue

		if (own.test(character)) {
			letters++
		} else if (!accepted.test(character)) {
			return false
		}
	}

	return letters > 0
}

function scriptClass(scripts: readonly string[]): RegExp {
	return new RegExp(`^[${scripts.map((script) => `\\p{Script=${script}}`).join("")}]$`, "u")
}
