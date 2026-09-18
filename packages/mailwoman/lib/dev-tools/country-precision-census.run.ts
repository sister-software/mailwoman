/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   COUNTRY PRECISION: when the input NAMES a country, does the parse answer that country?
 *
 *   Operator framing, 2026-09-15: a tier is a claim about BEHAVIOR rather than about coverage, and
 *   "it would be a massive failure if given an address that had a country in it that we somehow got
 *   that wrong at parsing time." This measures exactly that failure, and it needs no new truth — the
 *   country is IN the string, so the string is its own gold.
 *
 *   WHY IT IS NOT ALREADY GRADED. 375 of the 982 regression-board rows name a country in their input
 *   and only 41 both check (`status: pass`) and assert a `country` in `expectComponents`; 118 of the
 *   129 board directories have no country-asserting checking row at all. `componentOf`
 *   (`gauntlet/check-case.ts:35`) grades `country` only where that expectation is written, and a
 *   case's top-level `country` field is routing metadata — `routing.ts:28` reads it to pick a locale
 *   — never an assertion. So a row can name Venezuela, answer with the country dropped, and pass.
 *
 *   TRUTH IS THE ROW'S OWN `country` FIELD, NOT A REGEX OVER THE INPUT. The first version of this
 *   census matched country NAMES in the string and reported 9 contradictions. 7 of the 9 were the
 *   parser being right — `China Red` is a restaurant in Manchester, `Luxembourg House` a building in
 *   London, `Masala India` a curry house in Leyton, `Venezuela` a street in San Juan. That is the
 *   place-shaped-venue class the board already names in its own notes, and an instrument that cannot
 *   see it measures its own ambiguity rather than the parser's. The board states each row's country
 *   as an ISO alpha-2 code, so the comparison is code to code and a venue's name cannot enter it.
 *
 *   THREE OUTCOMES, kept apart. `agreed` is the parse naming the row's country. `contradicted` is the
 *   parse naming a different one, which is the failure the operator called massive. `dropped` is the
 *   parse naming none — a lesser failure and a different one, because a consumer can see an absent
 *   field and cannot see a wrong one. Folding the last two into one miss rate would hide which moved.
 *
 *   THE POPULATION IS THE QUESTION, and it is 361 of the 982 rows: those whose input names a country
 *   and whose named country is the row's own. The other 621 either name none (`Kabul`, `Al Wasl
 *   Road`) or name a decoy inside a venue, and counting either as a miss measures the board's
 *   composition rather than the parser's behavior.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/country-precision-census.run.ts [--limit <n>] [--json <path>]
 */

import { CountryISO2, CountryNames } from "@mailwoman/codex/country"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
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
 * Country names longest-first, so `United States` matches before `United` could and `Congo` never shadows `Democratic
 * Republic of the Congo`.
 */
const NAMES_BY_LENGTH = [...CountryNames].toSorted((left, right) => right.length - left.length)

const NAME_PATTERN = new RegExp(
	`(?:^|[\\s,])(${NAMES_BY_LENGTH.map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join("|")})(?:[\\s,.]|$)`,
	"iu"
)

/**
 * The country an input NAMES, or null.
 *
 * Deliberately exact-name only: no ISO codes, no abbreviations. `GA` is Georgia the US state and Gabon's alpha-2 at
 * once. Used to SELECT the population — a row is in scope when its input names the country the board declares for it —
 * never as truth about what the parse should answer, for the reason the file header states.
 */
function namedCountry(input: string): string | null {
	return NAME_PATTERN.exec(input)?.[1] ?? null
}

/**
 * Name-to-alpha-2, folded for lookup. The parse answers a SURFACE FORM (`Canada`, `United Kingdom`, `España`) and the
 * board states a CODE, so one side has to cross over. crossing the parse's side keeps the board's field untouched as
 * the reference.
 */
const CODE_BY_FOLDED_NAME = new Map(
	Object.entries(CountryISO2).map(([name, code]) => [name.trim().toLowerCase(), code])
)

/**
 * Surface forms ISO 3166-1 does not carry as alpha-2, and which a parse legitimately answers.
 *
 * `UK` is the one that matters and it is not a parser error: the alpha-2 for the United Kingdom is `GB`, `UK` is
 * exceptionally reserved, and every British address in the wild writes the second. The first version of this census
 * scored `14 New St, London EC2M 4HE, UK` and `West End, Woking, UK` as contradictions, which charged the parser for
 * the difference between a standard and the language.
 */
const SURFACE_ALIASES: Readonly<Record<string, string>> = {
	uk: "GB",
	usa: "US",
	"u s a": "US",
	"united states of america": "US",
}

/**
 * The alpha-2 a parsed country surface form denotes, or null when this table cannot place it.
 *
 * Null is a real answer and is counted as such: a surface form the codex does not carry is not a contradiction, it is
 * an unresolved reading, and scoring it as a miss would charge the parser for this table's gaps.
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
	 * The board's own alpha-2 for this row — the reference.
	 */
	truth: string
	/**
	 * The surface form the parse answered, verbatim.
	 */
	parsed: string | null
	/**
	 * That surface form as an alpha-2, or null when the codex cannot place it.
	 */
	parsedCode: string | null
	outcome: "agreed" | "contradicted" | "dropped" | "unplaceable"
}

const rows: Row[] = []

for (const seed of cases) {
	if (rows.length >= limit) break

	const truth = seed.country?.toUpperCase()

	// A row with no declared country has no reference, and guessing one from the input is the error this
	// census was rewritten to avoid.
	if (!truth) continue

	const named = namedCountry(seed.input)

	// THE POPULATION IS THE QUESTION. "Did we get a named country wrong" is only askable where the input
	// names one, and where the one it names is the row's own — 361 of the 982 rows. The other 621 either
	// name no country (`Kabul`, `Al Wasl Road`) or name a decoy inside a venue, and scoring either as a
	// miss measures the board's composition rather than the parser.
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
	await writeLocalTextFile(prettyJSON({ measuredAt: new Date().toISOString(), rows }), args.json)

	console.log(`\nwrote ${args.json}`)
}
