// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The ISO 15924 script of a code point, from the Unicode Script property of the runtime.
 *
 *   The answer is the registry's own code: `Latn`, `Grek`, `Hani`, `Deva`.
 *   `Zyyy` marks a Common code point (digits and punctuation), `Zinh` an Inherited one
 *   (a combining mark), and `Zzzz` a code point that has no script in the runtime's Unicode version.
 *
 *   # The Unicode version is the runtime's
 *
 *   The tables are the regular-expression engine's `\p{Script=…}` classes, so they add no byte to a bundle.
 *   The answer for a code point that a later Unicode version assigned depends on
 *   the runtime that runs the call: a Worker, a browser and Node can report `Zzzz`
 *   for a script that a newer one reports by name.
 *
 *   The test of this module pins the answers for a fixed list of code points.
 *
 *   The candidates are the registry's script codes that the runtime's regular-expression
 *   engine also names as a Script value, so the set follows both tables.
 *   A code point of a Unicode script that the registry omits reports `Zzzz`.
 *
 *   The lookup costs one array read for ASCII, and one cached read for a code point seen before.
 */

import { scriptSubtagRows } from "#artifacts/bcp47/script"
import type { BCP47 } from "#types"

/**
 * The scripts tried first, because most addresses are written in them.
 * The rest follow in the registry's order.
 */
const COMMON_FIRST = [
	"Zyyy",
	"Zinh",
	"Latn",
	"Hani",
	"Cyrl",
	"Arab",
	"Hang",
	"Hira",
	"Kana",
	"Grek",
	"Deva",
	"Thai",
	"Hebr",
]

/**
 * The most code points the cache holds before it starts again.
 */
const CACHE_LIMIT = 65_536

let matcher: { readonly pattern: RegExp; readonly codes: readonly BCP47.ScriptCode[] } | null = null

const cache = new Map<number, BCP47.ScriptCode>()

function isScriptValue(code: string): boolean {
	try {
		new RegExp(`\\p{Script=${code}}`, "u")

		return true
	} catch {
		return false
	}
}

function build(): NonNullable<typeof matcher> {
	const known = scriptSubtagRows()
		.map((row) => row.subtag)
		.filter((code) => /^[A-Z][a-z]{3}$/.test(code) && isScriptValue(code))

	const present = new Set(known)
	const first = COMMON_FIRST.filter((code) => present.has(code))
	const codes = [...first, ...known.filter((code) => !first.includes(code))] as BCP47.ScriptCode[]

	// Each script is one capture group, so one `exec` reports which group matched.
	const pattern = new RegExp(codes.map((code) => `(\\p{Script=${code}})`).join("|"), "u")

	return { pattern, codes }
}

/**
 * The ISO 15924 script of a code point.
 *
 * @param codePoint A Unicode scalar value, from 0 to 0x10FFFF.
 * @returns `Zyyy` for Common, `Zinh` for Inherited, and `Zzzz` when the runtime
 * assigns the code point no registry script.
 */
export function codePointScript(codePoint: number): BCP47.ScriptCode {
	if (codePoint < 0x80) {
		const lower = codePoint | 0x20

		return (lower >= 0x61 && lower <= 0x7a ? "Latn" : "Zyyy") as BCP47.ScriptCode
	}

	const cached = cache.get(codePoint)

	if (cached) return cached

	matcher ??= build()

	const found = matcher.pattern.exec(String.fromCodePoint(codePoint))
	let script: BCP47.ScriptCode = "Zzzz" as BCP47.ScriptCode

	if (found) {
		for (let group = 1; group < found.length; group++) {
			if (found[group] !== undefined) {
				script = matcher.codes[group - 1]!

				break
			}
		}
	}

	if (cache.size >= CACHE_LIMIT) {
		cache.clear()
	}

	cache.set(codePoint, script)

	return script
}
