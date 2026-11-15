// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Writes the postcode prefix reference answers `@mailwoman/recognize` is held to
 * to `packages/recognize/data/fixtures/postcode-prefix-parity.json`.
 *
 * For each country below, the tool reads the syntax pattern through `@mailwoman/postcode`'s
 * own readers, asks `PrefixAutomaton` whether each probe can still complete to a whole
 * postcode, and asks the country's `RegExp` whether the probe is a whole postcode.
 * It records the probes each answers yes to.
 *
 * The probes are every string of up to `maxLength` characters over the country's alphabet,
 * plus the prefixes of the country's example postcodes, each prefix with its last character
 * replaced by every alphabet character, and each prefix with every alphabet character appended.
 * The enumerated strings are not stored, because the Rust test enumerates them
 * again from `alphabet` and `maxLength`.
 *
 * The tool lives under `mailwoman` because `@mailwoman/postcode` is meant to depend
 * on `@mailwoman/recognize` in a later phase, and a tool inside `recognize` that
 * imports `@mailwoman/postcode` would close that cycle.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts [--check]`
 *
 * `--check` writes no file and exits non-zero when the committed file differs from what the code produces.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { postcodeSyntax } from "@mailwoman/postcode/country-formats"
import { PrefixAutomaton } from "@mailwoman/postcode/prefix/automaton"
import { type FormatConfig, format } from "oxfmt"

/**
 * One country's probe plan.
 */
interface CountryPlan {
	country: string
	/**
	 * The characters of the enumeration.
	 *
	 * It holds one character for each distinct behavior of the pattern and one the pattern never admits.
	 */
	alphabet: string
	maxLength: number
	/**
	 * Whole postcodes in the country's forms, as written and without a space.
	 */
	examples: readonly string[]
}

const PLANS: readonly CountryPlan[] = [
	{ country: "US", alphabet: "09- A", maxLength: 5, examples: ["10118-1234", "20500", "10118 1234", "101181234"] },
	{
		country: "GB",
		alphabet: "SW1A ",
		maxLength: 5,
		examples: ["SW1A 1AA", "M1 1AE", "GIR 0AA", "BFPO 1234", "sw1a1aa"],
	},
	{ country: "CA", alphabet: "K1A0 ", maxLength: 5, examples: ["K1A 0B1", "K1A0B1", "k1a 0b1"] },
	{ country: "NL", alphabet: "10SB ", maxLength: 5, examples: ["1012 LG", "1012LG", "2511 SB"] },
	{ country: "JP", alphabet: "01-A", maxLength: 5, examples: ["100-0001", "1000001"] },
	{ country: "DE", alphabet: "01A ", maxLength: 5, examples: ["68161", "01067"] },
	{ country: "BR", alphabet: "01-A", maxLength: 5, examples: ["01310-100", "01310100"] },
	{ country: "IE", alphabet: "A1 Z", maxLength: 5, examples: ["D02 X285", "A65 F4E2", "D02X285"] },
	{ country: "PL", alphabet: "01-A", maxLength: 5, examples: ["00-950", "00950"] },
	{ country: "SE", alphabet: "01 A", maxLength: 5, examples: ["114 55", "11455"] },
	{ country: "AR", alphabet: "C1A0", maxLength: 5, examples: ["C1425ABC", "1425", "B1636", "C1425"] },
	{ country: "PT", alphabet: "01-A", maxLength: 5, examples: ["1000-001", "1000001"] },
]

/**
 * Every string of up to `maxLength` characters over `alphabet`, the empty string included.
 */
function enumerate(alphabet: string, maxLength: number): string[] {
	const all = [""]
	let layer = [""]

	for (let length = 0; length < maxLength; length++) {
		layer = layer.flatMap((prefix) => [...alphabet].map((character) => prefix + character))
		all.push(...layer)
	}

	return all
}

/**
 * The probes beyond the enumeration: each prefix of each example, with its last character
 * replaced by each alphabet character, and with each alphabet character appended.
 */
function probesFor(plan: CountryPlan): string[] {
	const probes = new Set<string>()

	for (const example of plan.examples) {
		for (let length = 0; length <= example.length; length++) {
			const prefix = example.slice(0, length)

			probes.add(prefix)

			for (const character of plan.alphabet) {
				probes.add(prefix + character)

				if (length > 0) {
					probes.add(prefix.slice(0, -1) + character)
				}
			}
		}
	}

	return [...probes].toSorted()
}

/**
 * One country's fixture entry.
 */
interface CountryFixture {
	country: string
	/**
	 * The pattern as `postcodeSyntax` compiles it, between its anchors, matched case-insensitively.
	 */
	pattern: string
	alphabet: string
	maxLength: number
	/**
	 * Probes outside the enumeration, sorted.
	 */
	probes: string[]
	/**
	 * The enumerated and probed strings `PrefixAutomaton.canComplete` answers true for, sorted.
	 */
	completable: string[]
	/**
	 * The enumerated and probed strings the country's `RegExp` matches whole, sorted.
	 */
	accepted: string[]
}

/**
 * Strips the whole-pattern anchors `postcodeSyntax` puts around its alternatives.
 */
function unanchored(source: string): string {
	if (!source.startsWith("^") || !source.endsWith("$")) {
		throw new Error(`the pattern is not anchored at both ends: /${source}/`)
	}

	return source.slice(1, -1)
}

const countries = PLANS.map((plan): CountryFixture => {
	const syntax = postcodeSyntax(plan.country)

	if (!syntax) throw new Error(`${plan.country} has no postcode syntax`)

	const automaton = new PrefixAutomaton(syntax.pattern.source)
	const probes = probesFor(plan)
	const strings = [...new Set([...enumerate(plan.alphabet, plan.maxLength), ...probes])].toSorted()

	return {
		country: plan.country,
		pattern: unanchored(syntax.pattern.source),
		alphabet: plan.alphabet,
		maxLength: plan.maxLength,
		probes,
		completable: strings.filter((text) => automaton.canComplete(text)),
		accepted: strings.filter((text) => syntax.pattern.test(text)),
	}
})

const fixture = {
	$generatedBy: "packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts",
	$note:
		"Answers of PrefixAutomaton.canComplete and of each country's RegExp from @mailwoman/postcode, for the enumerated and probed strings. Do not edit by hand: rerun the generator.",
	countries,
}

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })
const path = workspacePath("recognize", "data", "fixtures", "postcode-prefix-parity.json")

// The committed text is the JSON as the repository's formatter writes it,
// so `yarn lint:oxfmt` accepts it. effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
}

const formatted = await format(path, prettyJSON(fixture), formatConfig)

if (formatted.errors.length) {
	throw new Error(`oxfmt could not format ${path}: ${formatted.errors.map((error) => error.message).join("; ")}`)
}

if (values.check) {
	// A missing or unreadable file is a failure of its own and mustn't read as "no difference".
	const committed = await readLocalTextFile(path)

	if (committed !== formatted.code) {
		console.error(`${path} differs from the postcode answers; rerun prefix-parity.run.ts`)

		process.exitCode = 1
	} else {
		console.log(`${countries.length} countries match ${path}`)
	}
} else {
	await writeLocalFile(formatted.code, path)

	console.log(`wrote ${countries.length} countries to ${path}`)
}
