/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Asks whether the street a board row expects appears in that country's address register. It also
 *   asks whether that street appears alongside the row's locality.
 *
 *   #2399's first task. A candidate assigned a leading venue name to `street` on rows where the real
 *   street sits second. The decode path holds no index of street names to separate the two. This
 *   measures whether such an index would have answered the question before one is built: a street the
 *   register attests is separable from a venue name the register does not.
 *
 *   The registers read here are the ones the corpus adapters already read. GB comes from HM Land
 *   Registry Price Paid (`ppd/<date>/gb-tuples.csv`, columns `NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE`).
 *   Every other country comes from its Overture addresses extract. That extract keeps the locality in
 *   `address_levels` rather than in `postal_city`.
 *
 *   A row whose country has no register on disk is reported as unmeasured rather than as absent. The two
 *   readings support different decisions.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/street/attestation.run.ts \
 *     --ids es-op3-label-cabestreros,gb-op2-east-west-fortess [--release 2026-05-20.0] [--json <out>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { normalizeStreetForKeyLocale, type StreetLocale } from "@mailwoman/resolver-wof-sqlite/street"
import { Globerator } from "spliterator/node/fs"

import { loadRegressionCases } from "#tools/eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		ids: { type: "string", description: "Comma-separated board row ids" },
		release: { type: "string", description: "Overture release directory (default: the newest on disk)" },
		json: { type: "string", description: "Write the per-row verdicts to this path" },
	},
})

if (!values.ids) throw new Error("--ids is required")

const wanted = new Set(
	values.ids
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
)

/**
 * The street-normalization locale this measurement folds a country's streets under.
 *
 * `streetLocaleForCountry` in `@mailwoman/osm/sdk` answers the same question for the OSM rooftop build.
 * Its membership records which countries have an OSM extract rather than
 * which countries the normalizer has rules for.
 *
 * It throws for `es`, `us` and `mx`, which this tool measures against Overture,
 * so the two registries serve different purposes.
 *
 * A country absent here is reported as unmeasured.
 * A fold under another language's rules would return a count of a key the register writes for no row.
 */
const MEASUREMENT_STREET_LOCALE = new Map<string, StreetLocale>([
	["gb", "en"],
	["us", "en"],
	["es", "es"],
	["mx", "es"],
	["fr", "fr"],
	["de", "de"],
	["it", "it"],
	["nl", "nl"],
	["pl", "pl"],
])

const cases = await loadRegressionCases()
const rows = cases.filter((seed) => wanted.has(seed.id))
const missing = [...wanted].filter((id) => !rows.some((seed) => seed.id === id))

if (missing.length) throw new Error(`No board row for: ${missing.join(", ")}`)

/**
 * The Overture release directories that hold an address extract.
 *
 * The newest is the default.
 * `--release` selects an older one.
 *
 * The most recent release on this host holds extracts truncated at 800,000 rows,
 * so a measurement against it reads zero for a street the full extract attests.
 */
const overtureRoot = dataRootPath("overture")
const releases = new Set<string>()

for await (const entry of Globerator.from("*/addresses-*.parquet", { cwd: overtureRoot, absolute: false })) {
	const directory = entry.split("/")[0]

	if (directory) {
		releases.add(directory)
	}
}

const release = values.release ?? [...releases].toSorted().at(-1)

if (!release) throw new Error(`No Overture address extract under ${overtureRoot}`)

// The register path reaches SQL text, a log line and the JSON verdict.
// Each of those three takes a string.
// No caller derives a further path from it, so the walk yields it as a string.
const gbRegisters: string[] = []

for await (const entry of Globerator.from("*/gb-tuples.csv", { cwd: dataRootPath("ppd"), absolute: true })) {
	gbRegisters.push(entry.toString())
}

const gbRegister = gbRegisters.toSorted().at(-1) ?? null

interface Verdict {
	id: string
	country: string
	street: string | null
	locality: string | null
	register: string | null
	inCountry: number | null
	withLocality: number | null
	/**
	 * Why the row was not measured, or `null` when it was.
	 *
	 * A row with no register on disk and a row whose country has no folding locale
	 * are both unmeasured for different reasons.
	 * A single `register: null` would read as one cause.
	 */
	unmeasured: "no-register" | "no-folding-locale" | "no-probe-token" | null
}

const verdicts: Verdict[] = []

using db = await openDuckDB()

for (const seed of rows) {
	const country = (seed.country ?? "").toUpperCase()
	const street = seed.expectComponents?.street ?? null
	const locality = seed.expectComponents?.locality ?? null

	if (!street) {
		verdicts.push({
			id: seed.id,
			country,
			street: null,
			locality,
			register: null,
			inCountry: null,
			withLocality: null,
			unmeasured: null,
		})

		continue
	}

	// The board writes a street as its input does (`Kingsland Rd`) and a register stores the expanded
	// form (`Kingsland Road`), so a raw string comparison answers 0 for a street with 1,915 records.
	// Both sides go through the resolver's own street-key normalizer.
	const streetLocale = MEASUREMENT_STREET_LOCALE.get(country.toLowerCase())

	if (!streetLocale) {
		verdicts.push({
			id: seed.id,
			country,
			street,
			locality,
			register: null,
			inCountry: null,
			withLocality: null,
			unmeasured: "no-folding-locale",
		})

		continue
	}

	const streetKey = normalizeStreetForKeyLocale(street, streetLocale)
	const localityLiteral = locality ? `'${escapeSQLString(locality)}'` : null
	let register: string | null = null
	let source: string | null = null
	let streetColumn = "street"
	let localityExpression: string | null = null

	if (country === "GB" && gbRegister) {
		register = gbRegister
		source = `read_csv('${escapeSQLString(gbRegister)}', header = true)`
		streetColumn = "STREET"
		// `CITY` is null on every row of this register.
		// The locality sits in `DISTRICT`.
		localityExpression = "DISTRICT"
	} else {
		const parquet = overtureRoot(release, `addresses-${country.toLowerCase()}.parquet`)

		if (await pathExists(parquet)) {
			register = parquet.toString()
			source = `read_parquet('${escapeSQLString(register)}')`
			// Overture keeps the locality in `address_levels`, and `postal_city` is empty on whole countries.
			localityExpression = "list_transform(address_levels, level -> level.value)"
		}
	}

	if (!source || !register) {
		verdicts.push({
			id: seed.id,
			country,
			street,
			locality,
			register: null,
			inCountry: null,
			withLocality: null,
			unmeasured: "no-register",
		})

		continue
	}

	// The longest alphabetic token discriminates better than the first one: `C. De los Cabestreros`
	// leads with `c.`, which matches most Spanish streets, while `cabestreros` matches its own.
	const probe = [...street.matchAll(/\p{L}{3,}/gu)].map((match) => match[0]).toSorted((a, b) => b.length - a.length)[0]

	if (!probe) {
		verdicts.push({
			id: seed.id,
			country,
			street,
			locality,
			register,
			inCountry: null,
			withLocality: null,
			unmeasured: "no-probe-token",
		})

		continue
	}

	const localityClause =
		localityLiteral && localityExpression
			? country === "GB"
				? `lower(trim("${localityExpression}")) = lower(trim(${localityLiteral}))`
				: `list_contains(list_transform(${localityExpression}, value -> lower(trim(value))), lower(trim(${localityLiteral})))`
			: null

	const candidates = (
		await db.runAndReadAll(
			`SELECT "${streetColumn}" AS street, count(*) AS n,
			        ${localityClause ? `count(*) FILTER (WHERE ${localityClause})` : "0"} AS n_locality
			 FROM ${source}
			 WHERE "${streetColumn}" IS NOT NULL
			   AND lower("${streetColumn}") LIKE '%${escapeSQLString(probe.toLowerCase())}%'
			 GROUP BY 1`
		)
	).getRowObjectsJS() as Array<{ street: string; n: bigint | number; n_locality: bigint | number }>

	let inCountry = 0
	let withLocality = localityClause ? 0 : null

	for (const candidate of candidates) {
		if (normalizeStreetForKeyLocale(candidate.street, streetLocale) !== streetKey) continue

		inCountry += Number(candidate.n)

		if (withLocality !== null) {
			withLocality += Number(candidate.n_locality)
		}
	}

	verdicts.push({ id: seed.id, country, street, locality, register, inCountry, withLocality, unmeasured: null })
}

console.log(`${verdicts.length} rows, Overture release ${release}${gbRegister ? `, GB register ${gbRegister}` : ""}\n`)

for (const verdict of verdicts) {
	if (verdict.street === null) {
		console.log(`  ${verdict.id} (${verdict.country})  expects no street — excluded`)

		continue
	}

	if (verdict.unmeasured === "no-folding-locale") {
		console.log(
			`  ${verdict.id} (${verdict.country})  no folding locale for ${verdict.country} — unmeasured` +
				`  (add it to MEASUREMENT_STREET_LOCALE once the normalizer has its rules)`
		)

		continue
	}

	if (verdict.unmeasured === "no-register") {
		console.log(`  ${verdict.id} (${verdict.country})  no register on disk — unmeasured`)

		continue
	}

	if (verdict.unmeasured === "no-probe-token") {
		console.log(`  ${verdict.id} (${verdict.country})  street "${verdict.street}" holds no 3-letter token — unmeasured`)

		continue
	}

	console.log(
		`  ${verdict.id} (${verdict.country})  street "${verdict.street}"` +
			`  in country: ${verdict.inCountry?.toLocaleString()}` +
			(verdict.withLocality === null
				? "  (row states no locality)"
				: `  with locality "${verdict.locality}": ${verdict.withLocality.toLocaleString()}`)
	)
}

const measured = verdicts.filter((verdict) => verdict.inCountry !== null)
const attestedInCountry = measured.filter((verdict) => (verdict.inCountry ?? 0) > 0)
const attestedWithLocality = measured.filter((verdict) => (verdict.withLocality ?? 0) > 0)

console.log(`\nmeasured: ${measured.length} of ${verdicts.length}`)
console.log(`  street attested anywhere in its country: ${attestedInCountry.length}`)
console.log(`  street attested with the row's locality:  ${attestedWithLocality.length}`)

if (values.json) {
	await writeLocalJSONFile({ release, gbRegister, verdicts }, values.json)

	console.log(`\nwrote ${values.json}`)
}
