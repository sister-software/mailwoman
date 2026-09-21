/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Write a coordinate panel that draws evenly across a country's regions (#2311).
 *
 *   The default US panel `$MAILWOMAN_DATA_ROOT/eval/coord/us.jsonl` carries 2,000 rows over 7 of the 50 states and DC,
 *   and five of those seven are the five regions `synth-suffix-boundary` draws from. A rate measured on it is a rate
 *   for those regions. The 97.7-point interior spread #2311 is about is invisible there, and no tool in the repository
 *   built the panel that exposed it.
 *
 *   The draw: GeoNames' postal export through `readTriplesFromGeonames`, which applies the known-locality filter and
 *   the per-country locality column (column 3 is the city for the US, admin2 for PT/MX/IN), then
 *   `applyLocalityQuota`. Therefore, one city's postcode list cannot fill a region, then a fixed count per region. A region the
 *   source holds fewer rows for contributes what it has, and the run reports which regions came up short.
 *
 *   The coordinate is the postcode's, straight from the export's own columns. It is good enough to place a row on a
 *   map and to reject a gross mis-geocode. it is not a locality centroid, so a probe grading rooftop distance against
 *   it is grading the wrong thing. Each row says so in `coordinate_basis`.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/stratified-panel.run.ts --out <path>
 *       node packages/mailwoman/lib/dev-tools/locality/stratified-panel.run.ts --country US --per-region 120
 */

import { formatAddress } from "@mailwoman/codex/address-format"
import { matchSubdivisionIn } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { mulberry32 } from "@mailwoman/core/random"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { GEONAMES_POSTAL_COLUMNS } from "@mailwoman/corpus/adapters/geonames/postal/adapter"
import {
	applyLocalityQuota,
	DEFAULT_LOCALITY_QUOTA,
	geonamesPostalPath,
	readTriplesFromGeonames,
} from "@mailwoman/corpus/tools/postcode-triples"

import { suffixTail } from "#dev-tools/coord-panel"

const { values } = parseArguments({
	options: {
		country: { type: "string", default: "US" },
		"country-name": { type: "string", default: "United States" },
		"per-region": { type: "string", default: "120" },
		out: { type: "string", default: String(dataRootPath("eval", "coord", "us-stratified.jsonl")) },
		/**
		 * The GeoNames postal export to draw from. Defaults to the standard fetch out-root for the country.
		 */
		source: { type: "string" },
		quota: { type: "string", default: String(DEFAULT_LOCALITY_QUOTA) },
		/**
		 * What the even draw is taken across: `region`, `shape` (the locality name's shape), or `region-shape`.
		 *
		 * Region answers #2311's interior spread. Shape answers a different question, and one the region draw cannot:
		 * measured on `candidate.db`, 34.7% of the 86,063 distinct US locality names end in a USPS street suffix (`Orland
		 * Park`, `Saxtons River`), while the default US panel draws that shape at 12.8% and the corpus recipe teaches it at
		 * 9.7%. A rate measured on a draw that under-samples the shape it fails on reports the easy population (#2329).
		 */
		stratify: { type: "string", default: "region" },
	},
})

const country = values.country!.toUpperCase()
const source = values.source ?? geonamesPostalPath(country)
const perRegion = Number(values["per-region"])

/**
 * The export's own coordinate for each postcode, keyed before the triples pass
 * so the filtered triples can take it without a second reader spelling the column map again.
 */
const coordinateOf = new Map<string, { lat: number; lon: number }>()

for await (const cells of readUnquotedTSV(source) as AsyncIterable<string[]>) {
	const postcode = (cells[GEONAMES_POSTAL_COLUMNS.postcode] ?? "").trim()
	const lat = Number(cells[GEONAMES_POSTAL_COLUMNS.latitude])
	const lon = Number(cells[GEONAMES_POSTAL_COLUMNS.longitude])

	if (!postcode || !Number.isFinite(lat) || !Number.isFinite(lon) || coordinateOf.has(postcode)) continue

	coordinateOf.set(postcode, { lat, lon })
}

const triples = await readTriplesFromGeonames(country, source, values["country-name"]!)
const quotaed = applyLocalityQuota(triples, Number(values.quota))

const STRATIFY = new Set(["region", "shape", "region-shape"])

if (!STRATIFY.has(values.stratify!)) {
	throw new Error(`--stratify ${values.stratify} is not one of: ${[...STRATIFY].join(", ")}`)
}

/**
 * The locality name's shape, in the same three buckets `us/locality-region-postcode-arms.run.ts`
 * reports, using the same {@linkcode suffixTail} so a rate read on this panel
 * and a rate read on that one are about the same populations.
 */
function shapeOf(locality: string): string {
	if (suffixTail(locality)) return "suffix-tail"

	return locality.trim().split(/\s+/).length > 1 ? "multi-word" : "single-word"
}

/**
 * A deterministic comparator that shuffles a bucket. Seeded so two runs of this tool write the same
 * panel: a panel that changes between draws cannot be used to compare two models measured a day apart.
 */
function seededOrder(size: number): (a: unknown, b: unknown) => number {
	const next = mulberry32(size)
	const keys = new Map<unknown, number>()

	return (a, b) => {
		if (!keys.has(a)) {
			keys.set(a, next())
		}

		if (!keys.has(b)) {
			keys.set(b, next())
		}

		return keys.get(a)! - keys.get(b)!
	}
}

/**
 * Keyed by the stratum the draw is even across. The region form is the one the panel writes out —
 * GeoNames publishes `California`, never `CA`, and the surface under test is the code —
 * so folding here keeps the shortfall report and the rows speaking the same vocabulary.
 */
const byStratum = new Map<string, Array<(typeof quotaed)[number] & { written: string }>>()

let keptSourceForm = 0

for (const triple of quotaed) {
	if (!coordinateOf.has(triple.postcode)) continue

	// A country whose subdivisions codex does not carry keeps the source's form, counted
	// so the run says how much of the panel that is rather than writing two kinds of row silently.
	const subdivision = matchSubdivisionIn(triple.cc, triple.region)

	if (!subdivision) {
		keptSourceForm++
	}

	const written = subdivision?.code ?? triple.region
	const shape = shapeOf(triple.locality)
	const key = values.stratify === "shape" ? shape : values.stratify === "region-shape" ? `${written} ${shape}` : written
	const bucket = byStratum.get(key)

	if (bucket) {
		bucket.push({ ...triple, written })
	} else {
		byStratum.set(key, [{ ...triple, written }])
	}
}

if (!byStratum.size) {
	throw new Error(
		`${source} yielded no usable rows for ${country}. ` +
			`\`POSTCODE_CONVENTIONS\` may not name ${country}, or the export may be absent.`
	)
}

const rows = []
const short: string[] = []

for (const [stratum, bucket] of [...byStratum].toSorted()) {
	if (bucket.length < perRegion) {
		short.push(`${stratum} ${bucket.length}`)
	}

	// Taking the head of the bucket is a sample ordered by the source, which is postcode order within a state. For a
	// region stratum that is harmless — the stratum already fixes the state. For a shape stratum it is not: the first
	// 400 suffix-tail names in US.txt are all Alaskan, so a shape draw taken from the head measures one state per
	// bucket. A seeded shuffle spreads each shape across the country. The region draw keeps its existing order so the
	// numbers already published against `us-stratified.jsonl` still describe the panel this writes.
	const drawn = values.stratify === "region" ? bucket : bucket.toSorted(seededOrder(bucket.length)).slice(0, perRegion)

	for (const triple of drawn.slice(0, perRegion)) {
		const coordinate = coordinateOf.get(triple.postcode)!

		rows.push({
			input: formatAddress(
				{ locality: triple.locality, region: triple.written, postcode: triple.postcode },
				triple.cc,
				{ singleLine: true }
			),
			lat: coordinate.lat,
			lon: coordinate.lon,
			country: triple.cc,
			expected: { locality: triple.locality, region: triple.written, postcode: triple.postcode },
			/**
			 * Named on every row because a consumer that grades distance needs to know
			 * it is holding a postcode centroid.
			 */
			coordinate_basis: "geonames-postcode-centroid",
		})
	}
}

await writeLocalJSONLFile(rows, values.out!)

console.log(
	`${source}: ${triples.length.toLocaleString()} triples, ${quotaed.length.toLocaleString()} after a quota of ` +
		`${values.quota} per locality, ${byStratum.size} ${values.stratify} stratum(s)\n`
)
console.log(`wrote ${rows.length.toLocaleString()} rows to ${values.out}`)

if (keptSourceForm) {
	console.log(
		`\n${keptSourceForm.toLocaleString()} row(s) keep the source's region form because codex carries no ` +
			`${country} subdivision table`
	)
}

if (short.length) {
	console.log(`\nstrata the source holds fewer than ${perRegion} rows for: ${short.join(", ")}`)
}

console.log(
	`\n${rows
		.slice(0, 3)
		.map((row) => `  ${row.input}`)
		.join("\n")}`
)
