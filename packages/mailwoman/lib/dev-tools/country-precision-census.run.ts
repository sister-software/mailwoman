/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Measures whether the parse returns the country for board rows whose input contains their board country's name.
 */

import { CountryISO2, CountryNames } from "@mailwoman/codex/country"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"

const { values: args } = parseArguments({
	options: {
		limit: { type: "string" },
		json: { type: "string" },
	},
})

/**
 * Lists country names longest first so the pattern prefers the longest match.
 */
const NAMES_BY_LENGTH = [...CountryNames].toSorted((left, right) => right.length - left.length)

const NAME_PATTERN = new RegExp(
	`(?:^|[\\s,])(${NAMES_BY_LENGTH.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join("|")})(?:[\\s,.]|$)`,
	"iu"
)

/**
 * Returns the full country name found in the input, or null.
 *
 * Codes and abbreviations are ambiguous, so they never select a row.
 * The match only selects rows.
 * The board's `country` field stays the reference.
 */
function namedCountry(input: string): string | null {
	return NAME_PATTERN.exec(input)?.[1] ?? null
}

/**
 * Maps lowercased country names to ISO alpha-2 codes, because the parser returns names
 * and the board stores codes.
 */
const CODE_BY_FOLDED_NAME = new Map(
	Object.entries(CountryISO2).map(([name, code]) => [name.trim().toLowerCase(), code])
)

/**
 * Maps parsed country forms that the codex does not resolve, such as `UK` to `GB`.
 */
const SURFACE_ALIASES: Readonly<Record<string, string>> = {
	uk: "GB",
	usa: "US",
	"u s a": "US",
	"united states of america": "US",
}

/**
 * Converts a parsed country to alpha-2, or returns null when it cannot be mapped.
 */
function codeOf(surface: string | null | undefined): string | null {
	if (!surface) return null

	const folded = surface.trim().toLowerCase().replaceAll(/[.,]/gu, "")
	const aliased = SURFACE_ALIASES[folded]

	if (aliased) return aliased

	if (/^[a-z]{2}$/u.test(folded)) return folded.toUpperCase()

	return CODE_BY_FOLDED_NAME.get(folded) ?? null
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const cases = await loadRegressionCases()
const limit = args.limit ? Number.parseInt(args.limit, 10) : Number.POSITIVE_INFINITY

/**
 * Holds one census row.
 */
interface Row {
	input: string
	/**
	 * Holds the board's alpha-2 country code.
	 */
	truth: string
	/**
	 * Holds the country the parser returned.
	 */
	parsed: string | null
	/**
	 * Holds the parsed country's alpha-2 code, or null when it cannot be mapped.
	 */
	parsedCode: string | null
	/**
	 * Separates a wrong country (`contradicted`) from a missing one (`dropped`).
	 */
	outcome: "agreed" | "contradicted" | "dropped" | "unplaceable"
}

const rows: Row[] = []

for (const seed of cases) {
	if (rows.length >= limit) break

	const truth = seed.country?.toUpperCase()

	if (!truth) continue

	const named = namedCountry(seed.input)

	// The census keeps only rows whose input contains the board country's name.
	if (!named || codeOf(named) !== truth) continue

	const parsed = decodeAsJSON(await classifier.parse(seed.input)).country ?? null
	const parsedCode = codeOf(parsed)

	const outcome: Row["outcome"] = !parsed
		? "dropped"
		: !parsedCode
			? "unplaceable"
			: parsedCode === truth
				? "agreed"
				: "contradicted"

	rows.push({ input: seed.input, truth, parsed, parsedCode, outcome })
}

const byOutcome = (outcome: Row["outcome"]) => rows.filter((row) => row.outcome === outcome)
const contradicted = byOutcome("contradicted")
const dropped = byOutcome("dropped")
const share = (n: number) => `${((100 * n) / rows.length).toFixed(1)}%`

console.log(`\ncountry precision — ${rows.length} board rows whose input NAMES its own country\n`)
console.log(`  agreed        ${byOutcome("agreed").length}   ${share(byOutcome("agreed").length)}`)
console.log(`  contradicted  ${contradicted.length}   ${share(contradicted.length)}   <- named a DIFFERENT country`)
console.log(`  dropped       ${dropped.length}   ${share(dropped.length)}   <- named none`)
console.log(`  unplaceable   ${byOutcome("unplaceable").length}   a surface form the codex cannot place`)

if (contradicted.length) {
	console.log("\ncontradicted rows, every one of them:\n")

	for (const row of contradicted) {
		console.log(`  ${row.input}`)
		console.log(`      board says ${row.truth}   parse answered ${row.parsed} (${row.parsedCode})`)
	}
}

if (dropped.length) {
	console.log(`\ndropped rows (${dropped.length}), first 15:\n`)

	for (const row of dropped.slice(0, 15)) {
		console.log(`  ${row.input}\n      board says ${row.truth}   parse answered nothing`)
	}
}

if (args.json) {
	await writeLocalJSONFile({ measuredAt: new Date().toISOString(), rows }, args.json)

	console.log(`\nwrote ${args.json}`)
}
