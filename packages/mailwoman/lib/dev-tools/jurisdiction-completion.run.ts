/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Completion per postal jurisdiction, which is the unit a parser is built for. Address systems follow
 *   postal, cadastral and administrative boundaries rather than sovereignty, the way UN/locode lists
 *   countries and territories together, so Hong Kong, Greenland, Jersey, Curaçao, the French overseas
 *   departments and the UK Overseas Territories each count as their own row. None of them can inherit
 *   its sovereign state's parser: a Jersey postcode is not a GB postcode shape, and Greenland's layout
 *   is not Denmark's.
 *
 *   `mwdev_coverage` answers the same question for the countries that appear in at least one register.
 *   This tool differs in the denominator: it enumerates every ISO 3166-1 alpha-2 code first, then joins
 *   the registers onto it, so a jurisdiction absent from all of them is a row reading zero rather than a
 *   row that does not exist. That distinction is the whole point. An absence nobody has looked at and an
 *   absence somebody measured are different readings, and a union-of-registers denominator cannot tell
 *   them apart.
 *
 *   Each dimension is reported on its own. A composite grade would hide which of the five is missing,
 *   and they are missing in different combinations: a jurisdiction can render an address without
 *   resolving one (a layout with no gazetteer), or resolve one without parsing it (a gazetteer with no
 *   corpus rows).
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/jurisdiction-completion.run.ts
 *       node packages/mailwoman/lib/dev-tools/jurisdiction-completion.run.ts --out-json <path>
 *       node packages/mailwoman/lib/dev-tools/jurisdiction-completion.run.ts --missing layout
 */

import { layoutForCountry } from "@mailwoman/codex/address-layouts"
import { ADDRESS_SYSTEM_CONVENTIONS } from "@mailwoman/codex/address-system-conventions"
import { CountryISO2 } from "@mailwoman/codex/country"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { readScopeConfig } from "@mailwoman/core/scope-config"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { censusCoverage, type CountryCoverage, newestManifest, resolveTrainingConfig } from "#coverage/index"

const { values } = parseArguments({
	options: {
		"out-json": { type: "string" },
		config: { type: "string" },
		/**
		 * Print the jurisdictions missing one named dimension, rather than the rollup.
		 */
		missing: { type: "string" },
	},
})

/**
 * Jurisdictions this project models separately from any ISO 3166-1 code, each
 * because its addresses are not expressible in the code's own grammar.
 *
 * Adding a row here is a claim that the jurisdiction needs its own parser behaviour,
 * so each carries the reason.
 */
const SUB_JURISDICTIONS: ReadonlyArray<{ code: string; within: string; why: string }> = [
	{ code: "XK", within: "XK", why: "Kosovo — operational, non-ISO, present in real data" },
	{ code: "SH-AC", within: "SH", why: "Ascension Island — own postcode, ASCN 1ZZ" },
	{ code: "SH-HL", within: "SH", why: "Saint Helena — own postcode, STHL 1ZZ" },
	{ code: "SH-TA", within: "SH", why: "Tristan da Cunha — own postcode, TDCU 1ZZ" },
	{ code: "US-AA", within: "US", why: "Armed Forces Americas — routing, not state geography" },
	{ code: "US-AE", within: "US", why: "Armed Forces Europe — routing, not state geography" },
	{ code: "US-AP", within: "US", why: "Armed Forces Pacific — routing, not state geography" },
	{ code: "GB-BFPO", within: "GB", why: "British Forces Post Office — routing, not a GB postcode" },
]

/**
 * One jurisdiction's reading across every register that says something about it.
 */
interface JurisdictionRow {
	code: string
	/**
	 * The ISO code whose registers answer for this row.
	 *
	 * Equal to `code` for an ordinary jurisdiction.
	 */
	joinsTo: string
	subJurisdiction: boolean
	/**
	 * Codex can print an address for it.
	 */
	layout: boolean
	/**
	 * Codex carries a parsing-conventions row for its address system.
	 */
	conventions: boolean
	corpusRows: number
	corpusStreetRows: number
	/**
	 * True when the training config's `country_weights` admits it and the corpus holds rows for it.
	 *
	 * Either one alone trains nothing.
	 */
	trains: boolean
	gazetteerPlaces: number
	geocodeTier: CountryCoverage["geocodeTier"]
	boardRows: number
	weightsPackage?: string
}

const config = resolveTrainingConfig(await readScopeConfig(), { requested: values.config })
const configPath = config.path
const manifestPath = await newestManifest()

if (!manifestPath) {
	throw new Error(
		`no corpus manifest under the data root — that is an absence of FILES, not of coverage. The config resolved to ${configPath}.`
	)
}

const report = await censusCoverage({
	configPath,
	manifestPath,
	casesRoot: repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "cases"),
})

const byCountry = new Map(report.countries.map((c) => [c.country, c]))

/**
 * The conventions table is keyed by address system rather than by country,
 * and a system serves several countries.
 *
 * `us` covers US; `gb` covers GB.
 * No system currently spans more than its own code, so the lookup is the lower-cased code.
 * When one does, this is the line that has to learn about it.
 */
const hasConventions = (code: string): boolean =>
	Object.hasOwn(ADDRESS_SYSTEM_CONVENTIONS, code.toLowerCase() as keyof typeof ADDRESS_SYSTEM_CONVENTIONS)

function rowFor(code: string, joinsTo: string, subJurisdiction: boolean): JurisdictionRow {
	const c = byCountry.get(joinsTo)

	return {
		code,
		joinsTo,
		subJurisdiction,
		layout: layoutForCountry(joinsTo) !== null,
		conventions: hasConventions(joinsTo),
		// A sub-jurisdiction has no register of its own.
		// It reads its parent's numbers, and reporting them as the sub-jurisdiction's own would double-count.
		// Zero here says "no separate reading exists", which is the true statement.
		corpusRows: subJurisdiction ? 0 : (c?.corpusRows ?? 0),
		corpusStreetRows: subJurisdiction ? 0 : (c?.corpusStreetRows ?? 0),
		trains: subJurisdiction ? false : (c?.admitted ?? false) && (c?.corpusRows ?? 0) > 0,
		gazetteerPlaces: subJurisdiction ? 0 : (c?.gazetteerPlaces ?? 0),
		geocodeTier: subJurisdiction ? "none" : (c?.geocodeTier ?? "none"),
		boardRows: subJurisdiction ? 0 : (c?.boardRows ?? 0),
		...(c?.weightsPackage && !subJurisdiction ? { weightsPackage: c.weightsPackage } : {}),
	}
}

const rows: JurisdictionRow[] = [
	...Object.values(CountryISO2).map((code) => rowFor(code, code, false)),
	...SUB_JURISDICTIONS.map((s) => rowFor(s.code, s.within, s.code !== s.within)),
].toSorted((a, b) => a.code.localeCompare(b.code))

const n = rows.length
const count = (predicate: (r: JurisdictionRow) => boolean): number => rows.filter(predicate).length

const DIMENSIONS: ReadonlyArray<{ name: string; held: (r: JurisdictionRow) => boolean }> = [
	{ name: "renders — codex layout", held: (r) => r.layout },
	{ name: "resolves — gazetteer places > 0", held: (r) => r.gazetteerPlaces > 0 },
	{ name: "parses — trains on corpus rows", held: (r) => r.trains },
	// Admission is part of the predicate.
	// Street rows the config does not admit train nothing, and reporting them as
	// held would put this row above the one it depends on.
	{ name: "parses streets — street-labeled rows", held: (r) => r.trains && r.corpusStreetRows > 0 },
	{ name: "measured — board rows > 0", held: (r) => r.boardRows > 0 },
	{ name: "rooftop — obtainable outside the repo", held: (r) => r.geocodeTier === "rooftop-published" },
	{ name: "conventions — codex parsing row", held: (r) => r.conventions },
]

if (values.missing) {
	const dimension = DIMENSIONS.find((d) => d.name.startsWith(values.missing as string))

	if (!dimension) {
		throw new Error(
			`--missing ${values.missing} names no dimension. One of: ${DIMENSIONS.map((d) => d.name.split(" ")[0]).join(", ")}`
		)
	}

	const absent = rows.filter((r) => !dimension.held(r))

	console.log(`# ${absent.length} of ${n} jurisdictions lack: ${dimension.name}\n`)
	console.log(absent.map((r) => r.code).join(" "))
} else {
	console.log(`# Completion per postal jurisdiction\n`)
	console.log(
		`${n} jurisdictions: ${Object.values(CountryISO2).length} ISO 3166-1 alpha-2 codes plus ${SUB_JURISDICTIONS.length} modelled separately.`
	)
	console.log(
		`Corpus census taken ${report.corpusCensusTakenAt ?? "this run"}; config ${configPath} (${config.provenance}).\n`
	)
	console.log("| dimension | held | share |")
	console.log("| --- | --: | --: |")

	for (const d of DIMENSIONS) {
		const held = count(d.held)

		console.log(`| ${d.name} | ${held}/${n} | ${formatPercent(held / n, 1)} |`)
	}

	const noneAtAll = rows.filter((r) => !r.layout && r.gazetteerPlaces === 0 && !r.trains && r.boardRows === 0)

	console.log(`\n## Nothing in any register: ${noneAtAll.length} of ${n}\n`)
	console.log(noneAtAll.map((r) => r.code).join(" ") || "(none)")

	const rendersOnly = rows.filter((r) => r.layout && r.gazetteerPlaces === 0)

	console.log(`\n## Prints an address but resolves nothing: ${rendersOnly.length} of ${n}\n`)
	console.log(rendersOnly.map((r) => r.code).join(" ") || "(none)")

	const resolvesNotParses = rows.filter((r) => r.gazetteerPlaces > 0 && !r.trains)

	console.log(`\n## Resolves but trains on nothing: ${resolvesNotParses.length} of ${n}\n`)
	console.log(resolvesNotParses.map((r) => r.code).join(" ") || "(none)")
}

if (values["out-json"]) {
	await writeLocalJSONFile(
		{ takenAt: new Date().toISOString(), configPath, configProvenance: config.provenance, rows },
		values["out-json"] as string
	)

	console.log(`\nwrote ${values["out-json"]}`)
}
