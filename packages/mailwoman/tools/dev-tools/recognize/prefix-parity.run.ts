// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Writes the postcode prefix reference answers `@mailwoman/recognize` is held to
 * to `packages/recognize/data/fixtures/postcode-prefix-parity.json`.
 *
 * For every country the `postal` family holds, the tool reads the syntax through
 * `@mailwoman/postcode`'s own readers and records four sets of answers over the country's probes:
 *
 * - `completable`: the probes `PrefixAutomaton.canComplete` answers yes to, for the bare code.
 * - `accepted`: the probes the country's `RegExp` matches whole.
 * - `printedCompletable`: for a country whose layout prints a prefix, the probes the printed
 *   branch of `canComplete` in `completion.ts` answers yes to: the prefix typed in part,
 *   or typed whole and followed by a prefix of the code.
 * - `printedAccepted`: the probes that start with the prefix, in `toUpperCase`'s reading,
 *   and whose remainder matches the country's `RegExp` after its leading white space.
 *
 * The probes are every string of up to `maxLength` characters over the country's alphabet,
 * the prefixes of the country's example postcodes with each alphabet character appended
 * or substituted for the last character, and the prefixes of inputs built to probe
 * non-ASCII text: fullwidth and Arabic-Indic digits, the Kelvin sign, the long s,
 * the dotless i, non-breaking and ideographic spaces and combining marks.
 * The enumerated strings are not stored, because the Rust test enumerates them
 * again from `alphabet` and `maxLength`.
 *
 * The tool lives under `mailwoman` because it imports `@mailwoman/postcode`
 * and a tool inside `recognize` that does so would close a dependency cycle.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts [--check]`
 *
 * `--check` writes no file and exits non-zero when the committed file differs from what the code produces.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { postcodeSyntax, postcodeSyntaxCountries } from "@mailwoman/postcode/country-formats"
import { PrefixAutomaton } from "@mailwoman/postcode/prefix/automaton"
import { PostalMetadata } from "@mailwoman/postcode/recognize/postal.generated"
import { probeInputs } from "@mailwoman/postcode/tools/postal/differential"
import { type FormatConfig, format } from "oxfmt"

/**
 * The most characters an alphabet holds, so the enumeration stays small.
 */
const ALPHABET_LIMIT = 6

/**
 * The longest enumerated string.
 */
const MAX_LENGTH = 4

/**
 * The libaddressinput examples of each country, as `completion.test.ts` reads them.
 */
async function readExamples(): Promise<Map<string, string[]>> {
	const dir = resolvePackageDirectory("@mailwoman/dictionaries")("data", "chromium-i18n", "ssl-address")
	const examples = new Map<string, string[]>()

	for (const country of postcodeSyntaxCountries()) {
		const metadata = await readLocalJSONFile<{ readonly zipex?: string }>(dir(`${country}.json`))

		examples.set(country, metadata.zipex ? metadata.zipex.split(",") : [])
	}

	return examples
}

/**
 * The characters of a country's enumeration: a digit or two, the first letters its examples
 * use in both cases, the separators its pattern admits, and one character no pattern admits.
 */
function alphabetFor(examples: readonly string[], source: string): string {
	const characters = new Set<string>()
	const text = examples.join("")
	const digits = [...new Set([...text].filter((character) => /[0-9]/u.test(character)))].toSorted()
	const letters = [...new Set([...text.toUpperCase()].filter((character) => /[A-Z]/u.test(character)))]

	if (digits.length) {
		characters.add(digits[0]!)
		characters.add(digits.at(-1)!)
	}

	if (/\\s/u.test(source)) {
		characters.add(" ")
	}

	if (/-/u.test(source) || /-/u.test(text)) {
		characters.add("-")
	}

	for (const letter of letters.slice(0, 2)) {
		characters.add(letter)
	}

	if (letters[0]) {
		characters.add(letters[0].toLowerCase())
	}

	characters.add("#")

	return [...characters].slice(0, ALPHABET_LIMIT).join("")
}

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
 * replaced by each alphabet character, and with each alphabet character appended,
 * and each prefix of each non-ASCII probe.
 */
function probesFor(alphabet: string, examples: readonly string[]): string[] {
	const probes = new Set<string>()

	for (const example of examples) {
		for (let length = 0; length <= example.length; length++) {
			const prefix = example.slice(0, length)

			probes.add(prefix)

			for (const character of alphabet) {
				probes.add(prefix + character)

				if (length > 0) {
					probes.add(prefix.slice(0, -1) + character)
				}
			}
		}
	}

	for (const probe of probeInputs(examples)) {
		for (let length = 0; length <= probe.length; length++) {
			probes.add(probe.slice(0, length))
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
	 * The ID of the country's bare shape in the `postal` family.
	 */
	shape: string
	/**
	 * The ID of the country's printed shape, for a country whose layout prints a prefix.
	 */
	printedShape?: string
	/**
	 * The literal the layout prints before the code.
	 */
	prefix?: string
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
	/**
	 * The strings the printed branch of `canComplete` answers true for, sorted.
	 */
	printedCompletable?: string[]
	/**
	 * The strings that start with the prefix and whose remainder the `RegExp` matches, sorted.
	 */
	printedAccepted?: string[]
}

const SHAPES = Object.entries(PostalMetadata.shapes) as Array<
	[string, { kind: string; countries: readonly string[]; bare?: string }]
>

function shapeOf(country: string, kind: "code" | "printed"): string | undefined {
	return SHAPES.find(([, shape]) => shape.kind === kind && shape.countries.includes(country))?.[0]
}

const examples = await readExamples()

const countries = postcodeSyntaxCountries().map((country): CountryFixture => {
	const syntax = postcodeSyntax(country)!
	const sample = examples.get(country)!
	const alphabet = alphabetFor(sample, syntax.pattern.source)
	const automaton = new PrefixAutomaton(syntax.pattern.source)
	const probes = probesFor(alphabet, sample)
	const strings = [...new Set([...enumerate(alphabet, MAX_LENGTH), ...probes])].toSorted()
	const { prefix } = syntax

	const entry: CountryFixture = {
		country,
		shape: shapeOf(country, "code")!,
		alphabet,
		maxLength: MAX_LENGTH,
		probes,
		completable: strings.filter((text) => automaton.canComplete(text)),
		accepted: strings.filter((text) => syntax.pattern.test(text)),
	}

	if (prefix) {
		// The printed branch of `syntaxCanComplete` in completion.ts, on a value with no leading white space trimmed away.
		entry.printedShape = shapeOf(country, "printed")!
		entry.prefix = prefix

		const printedCanComplete = (text: string): boolean => {
			const upper = text.toUpperCase()

			if (prefix.startsWith(upper)) {
				return true
			}

			const rest = text.slice(prefix.length).trimStart()

			return upper.startsWith(prefix) && automaton.canComplete(rest)
		}

		const printedIsWhole = (text: string): boolean => {
			const rest = text.slice(prefix.length).trimStart()

			return text.toUpperCase().startsWith(prefix) && syntax.pattern.test(rest)
		}

		entry.printedCompletable = strings.filter(printedCanComplete)
		entry.printedAccepted = strings.filter(printedIsWhole)
	}

	return entry
})

const fixture = {
	$generatedBy: "packages/mailwoman/tools/dev-tools/recognize/prefix-parity.run.ts",
	$note:
		"Answers of PrefixAutomaton.canComplete, of each country's RegExp and of the printed branch of canComplete from @mailwoman/postcode, for the enumerated and probed strings. Do not edit by hand: rerun the generator.",
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
