/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Country precision: when an input names a country, does the parse return it?
 *
 *   Most rows that name a country do not check the parsed country.
 *   A row's top-level `country` field unexpectedly selects a locale.
 *   So a row can name Venezuela, omit the parsed country, and still pass.
 *
 *   The board's `country` field is the reference, and the words in the input only select rows. Venue names
 *   can look like country names, so the input alone is ambiguous. The board uses ISO alpha-2 codes,
 *   which lets us compare countries without mistaking a venue for one.
 *
 *   The outcomes distinguish a correct country (`agreed`), a different country (`contradicted`), and
 *   no country (`dropped`). A missing country is different from a wrong one, so they are counted apart.
 *
 *   The census includes rows whose input names the country listed in the board: 361 of 982 rows.
 *   Rows with no country name or a country-like venue name are excluded.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/country-precision-census.run.ts [--limit <n>] [--json <path>]
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
 * Match longer country names first, so longer names are not mistaken for shorter ones.
 */
const NAMES_BY_LENGTH = [...CountryNames].toSorted((left, right) => right.length - left.length)

const NAME_PATTERN = new RegExp(
	`(?:^|[\\s,])(${NAMES_BY_LENGTH.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join("|")})(?:[\\s,.]|$)`,
	"iu"
)

/**
 * Return the country named in the input, or null if none is found.
 *
 * The pattern matches full country names only.
 * A code or abbreviation can be ambiguous, so neither selects a row.
 *
 * This selects rows for the census.
 * The board's country field remains the reference.
 */
function namedCountry(input: string): string | null {
	return NAME_PATTERN.exec(input)?.[1] ?? null
}

/**
 * Map folded country names to ISO alpha-2 codes.
 *
 * The parser returns country names while the board stores codes, so convert the
 * parsed name and leave the board's reference unchanged.
 */
const CODE_BY_FOLDED_NAME = new Map(
	Object.entries(CountryISO2).map(([name, code]) => [name.trim().toLowerCase(), code])
)

/**
 * Map country names that do not directly match an alpha-2 code in the codex.
 *
 * In particular, map `UK` to `GB`, the alpha-2 code for the United Kingdom.
 */
const SURFACE_ALIASES: Readonly<Record<string, string>> = {
	uk: "GB",
	usa: "US",
	"u s a": "US",
	"united states of america": "US",
}

/**
 * Convert a parsed country name to alpha-2, or return null if it cannot be mapped.
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

interface Row {
	input: string
	/**
	 * The board's alpha-2 country code.
	 */
	truth: string
	/**
	 * The country name returned by the parser.
	 */
	parsed: string | null
	/**
	 * The parsed country's alpha-2 code, or null if unknown.
	 */
	parsedCode: string | null
	outcome: "agreed" | "contradicted" | "dropped" | "unplaceable"
}

const rows: Row[] = []

for (const seed of cases) {
	if (rows.length >= limit) break

	const truth = seed.country?.toUpperCase()

	// Without a board country, there is no reference for comparison.
	if (!truth) continue

	const named = namedCountry(seed.input)

	// Include only rows where the input names the country listed by the board.
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
