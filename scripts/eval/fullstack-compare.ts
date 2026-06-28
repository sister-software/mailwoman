/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   "What's possible" probe. Takes the cases BOTH our parsers fail (v0_pass=false AND
 *   neural_pass=false in a harness JSON sidecar) and fires them at free, no-key, full-stack
 *   gazetteer geocoders — Photon (komoot, OSM-backed, the open-source Pelias peer) and Nominatim
 *   (OSM) — to see whether a full search+gazetteer stack recovers what a pure parser can't.
 *
 *   This is NOT a fair head-to-head (full geocoders normalize/translate names, e.g. München→Munich,
 *   Nederland→Netherlands, and resolve against a place index our parser doesn't have). It's a
 *   capability-ceiling probe: if Photon keeps `Plein 1944` whole as a street, the fragmentation is
 *   OURS to fix, not intrinsic. Comparison is deliberately lenient (substring, case-folded).
 *
 *   Politeness: 3s backoff between cases (Nominatim's usage policy is ≤1 req/s + a UA header).
 *
 *   Usage: node --experimental-strip-types scripts/eval/fullstack-compare.ts\
 *   --harness /tmp/v072-eval/harness.json\
 *   --out-md /tmp/fullstack-compare.md --out-json /tmp/fullstack-compare.json
 *
 *   Optional: --geocode-earth-key <key> also queries api.geocode.earth (real Pelias) per case.
 */

import { readFileSync, writeFileSync } from "node:fs"

interface Args {
	harnessPath: string
	outMd?: string
	outJson?: string
	geocodeEarthKey?: string
	backoffMs: number
}
function parseArgs(): Args {
	const a = process.argv.slice(2)
	const out: Partial<Args> = { backoffMs: 3000 }

	for (let i = 0; i < a.length; i++) {
		if (a[i] === "--harness" && a[i + 1]) out.harnessPath = a[++i]
		else if (a[i] === "--out-md" && a[i + 1]) out.outMd = a[++i]
		else if (a[i] === "--out-json" && a[i + 1]) out.outJson = a[++i]
		else if (a[i] === "--geocode-earth-key" && a[i + 1]) out.geocodeEarthKey = a[++i]
		else if (a[i] === "--backoff-ms" && a[i + 1]) out.backoffMs = Number(a[++i])
	}

	if (!out.harnessPath) {
		console.error("--harness <harness.json> required")
		process.exit(1)
	}

	return out as Args
}

type Rec = Record<string, string>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const norm = (s: string | undefined) => (s ?? "").toLowerCase().trim()

/** Lenient: did the stack produce a value matching expected (substring either way), per tag? */
function tagHit(expected: string, actual: string | undefined): boolean {
	if (!actual) return false
	const e = norm(expected),
		x = norm(actual)

	return e === x || e.includes(x) || x.includes(e)
}

/** A geocoder property bag — we only ever read string fields off it. */
type Props = Record<string, string | undefined>
/** Photon / geocode.earth GeoJSON-ish response (only the bits we read). */
interface FeatureResp {
	features?: Array<{ properties?: Props }>
}
/** Nominatim response: array of results, each with an `address` bag. */
type NominatimResp = Array<{ address?: Props }>
/** One extracted assertion from the harness JSON sidecar. */
interface HarnessRow {
	v0_pass: boolean
	neural_pass: boolean
	input: string
	locale: string
	expected: Array<Record<string, string[]>>
}
interface ScoreResult {
	hits: number
	total: number
	hitTags: string[]
}
interface ResultRow {
	locale: string
	input: string
	expected: Rec
	photon: Rec
	photonScore: ScoreResult
	photonRaw: unknown
	nominatim: Rec
	nominatimScore: ScoreResult
	nominatimRaw: unknown
	geocodeEarth?: Rec
	geocodeEarthScore?: ScoreResult
}

// ---- mappers: each geocoder's response → our component schema --------------------------------

function mapPhoton(p: Props | undefined): Rec {
	if (!p) return {}
	const out: Rec = {}

	if (p.housenumber) out.house_number = p.housenumber

	if (p.street) out.street = p.street
	else if ((p.type === "street" || p.osm_key === "highway") && p.name) out.street = p.name

	if (p.city) out.locality = p.city
	else if (p.district) out.locality = p.district

	if (p.state) out.region = p.state

	if (p.postcode) out.postcode = p.postcode

	if (p.country) out.country = p.country

	if (!out.street && !out.house_number && p.name) out.venue = p.name

	// POI fallback
	return out
}
function mapNominatim(a: Props | undefined): Rec {
	if (!a) return {}
	const out: Rec = {}

	if (a.house_number) out.house_number = a.house_number

	if (a.road) out.street = a.road
	const loc = a.city || a.town || a.village || a.municipality || a.suburb

	if (loc) out.locality = loc

	if (a.state) out.region = a.state

	if (a.postcode) out.postcode = a.postcode

	if (a.country) out.country = a.country

	return out
}
function mapGeocodeEarth(props: Props | undefined): Rec {
	if (!props) return {}
	const out: Rec = {}

	if (props.housenumber) out.house_number = props.housenumber

	if (props.street) out.street = props.street
	else if (props.layer === "street" && props.name) out.street = props.name

	if (props.locality) out.locality = props.locality

	if (props.region) out.region = props.region

	if (props.postalcode) out.postcode = props.postalcode

	if (props.country) out.country = props.country

	return out
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })

		if (!res.ok) return { __error: `HTTP ${res.status}` }

		return await res.json()
	} catch (err) {
		return { __error: (err as Error).message }
	}
}

async function main(): Promise<void> {
	const args = parseArgs()
	const harness = JSON.parse(readFileSync(args.harnessPath, "utf8")) as HarnessRow[]
	const bothFail = harness.filter((r) => !r.v0_pass && !r.neural_pass)
	console.error(`Both-fail cases: ${bothFail.length}`)
	console.error(`Geocoders: Photon, Nominatim${args.geocodeEarthKey ? ", geocode.earth(Pelias)" : ""}`)

	const UA = "mailwoman-eval/0.1 (teffen@sister.software)"
	const results: ResultRow[] = []

	for (let i = 0; i < bothFail.length; i++) {
		const c = bothFail[i]!
		const q = encodeURIComponent(c.input)
		// Harness expected values are string[] (e.g. {"street":["Main St"]}); flatten to strings.
		const expected: Rec = {}

		for (const [k, v] of Object.entries((c.expected[0] ?? {}) as Record<string, unknown>)) {
			expected[k] = Array.isArray(v) ? v.join(" ") : String(v)
		}

		const photonRaw = (await fetchJson(`https://photon.komoot.io/api/?q=${q}&limit=1`)) as FeatureResp | null
		const nomRaw = (await fetchJson(
			`https://nominatim.openstreetmap.org/search?q=${q}&format=jsonv2&addressdetails=1&limit=1`,
			{
				"User-Agent": UA,
			}
		)) as NominatimResp | null
		let geRaw: FeatureResp | null = null

		if (args.geocodeEarthKey) {
			// The compare-tool demo key is origin-locked to pelias.github.io; send the same
			// Referer/Origin a browser does (Node's fetch allows these; browsers forbid them).
			geRaw = (await fetchJson(`https://api.geocode.earth/v1/search?text=${q}&size=1&api_key=${args.geocodeEarthKey}`, {
				Referer: "https://pelias.github.io/compare/",
				Origin: "https://pelias.github.io",
			})) as FeatureResp | null
		}

		const photon = mapPhoton(photonRaw?.features?.[0]?.properties)
		const nominatim = mapNominatim(nomRaw?.[0]?.address)
		const geocodeEarth = geRaw ? mapGeocodeEarth(geRaw.features?.[0]?.properties) : undefined

		// Lenient per-tag recovery against our expected, per stack.
		const score = (mapped: Rec) => {
			const tags = Object.keys(expected)
			const hits = tags.filter((t) => tagHit(expected[t]!, mapped[t]))

			return { hits: hits.length, total: tags.length, hitTags: hits }
		}
		const row = {
			locale: c.locale,
			input: c.input,
			expected,
			photon,
			photonScore: score(photon),
			photonRaw: photonRaw?.features?.[0]?.properties ?? photonRaw,
			nominatim,
			nominatimScore: score(nominatim),
			nominatimRaw: nomRaw?.[0]?.address ?? nomRaw,
			...(geocodeEarth ? { geocodeEarth, geocodeEarthScore: score(geocodeEarth) } : {}),
		}
		results.push(row)
		console.error(`  [${i + 1}/${bothFail.length}] ${c.input}`)
		console.error(
			`       photon ${row.photonScore.hits}/${row.photonScore.total}  nominatim ${row.nominatimScore.hits}/${row.nominatimScore.total}`
		)

		if (i < bothFail.length - 1) await sleep(args.backoffMs)
	}

	// Markdown report
	const md: string[] = []
	md.push("# Full-stack capability probe — both-fail cases\n")
	md.push("Cases where BOTH the v0 rule parser AND the neural model fail, fired at free OSM-backed")
	md.push("full-stack geocoders (Photon = open-source Pelias peer; Nominatim = OSM). Lenient match.")
	md.push("Not a fair head-to-head — a capability ceiling: what a gazetteer stack can recover.\n")
	const tot = results.length
	const pSolved = results.filter((r) => r.photonScore.hits === r.photonScore.total && r.photonScore.total > 0).length
	const nSolved = results.filter(
		(r) => r.nominatimScore.hits === r.nominatimScore.total && r.nominatimScore.total > 0
	).length
	const eitherStreet = results.filter((r) => {
		if (!r.expected.street) return false

		return tagHit(r.expected.street, r.photon.street) || tagHit(r.expected.street, r.nominatim.street)
	}).length
	const withStreet = results.filter((r) => r.expected.street).length
	md.push(`**Fully recovered (all expected tags, lenient):** Photon ${pSolved}/${tot} · Nominatim ${nSolved}/${tot}`)
	md.push(
		`**Street kept whole (the fragmentation we fail on):** ${eitherStreet}/${withStreet} cases with an expected street\n`
	)
	md.push("| Locale | Input | Expected | Photon (mapped) | Nominatim (mapped) | P | N |")
	md.push("|---|---|---|---|---|--:|--:|")

	for (const r of results) {
		const fmt = (o: Rec) =>
			Object.entries(o)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ") || "—"
		md.push(
			`| ${r.locale} | \`${r.input}\` | ${fmt(r.expected)} | ${fmt(r.photon)} | ${fmt(r.nominatim)} | ${r.photonScore.hits}/${r.photonScore.total} | ${r.nominatimScore.hits}/${r.nominatimScore.total} |`
		)
	}
	const mdText = md.join("\n") + "\n"

	if (args.outMd) writeFileSync(args.outMd, mdText)

	if (args.outJson) writeFileSync(args.outJson, JSON.stringify(results, null, 2))
	console.log(mdText)
	console.error(`\nWrote ${args.outMd ?? "(no md)"} / ${args.outJson ?? "(no json)"}`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
