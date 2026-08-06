/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `panel-v1.jsonl` — the 420-row, hash-pinned benchmark panel the three-arm Pelias
 *   comparison runs against (docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md §4).
 *
 *   Deterministic by construction: every draw is a seeded Fisher-Yates over a candidate list built
 *   in stable file order, so re-running this script reproduces the file byte-for-byte. The seed is
 *   `PANEL_SEED` below and is recorded in the sidecar; changing it MUST come with a new panel
 *   version (panel-v2), never an in-place reshuffle of v1.
 *
 *   ## Why the input strings are RENDERED, not copied
 *
 *   The repo's coordinate-bearing rows (`data/eval/external/oa-*-coord-*.jsonl`) were built to
 *   stress the PARSER: `build-oa-coord-golden.ts` cycles three render orders on purpose, including
 *   `city-first` — "Ansan, 32270, Route de Crastes 350". No user types that, and mailwoman was
 *   trained on those orders while Pelias was not, so feeding them to all three arms would hand our
 *   own arm a structural advantage that has nothing to do with geocoding. So this script keeps the
 *   truth (components + lat/lon) and renders ONE natural postal order per country, identical for
 *   every arm — which is what §4's "the exact same raw query string to all three arms" is for.
 *
 *   ## Strata
 *
 *   All three of the plan's `truth_type` values are populated, unevenly. `rooftop` (a point
 *   address) comes from the OpenAddresses-derived goldens; `city-only` (an admin answer graded
 *   against a tolerance) and `venue` (a named place of business) come from the gauntlet and
 *   hard-slice boards, classified by the components the board itself asserts — see
 *   `boardTruthType`. The venue stratum is SMALL and sits only in the countries whose boards carry
 *   venue rows; nothing is synthesized to even it out (`poi-board.jsonl`'s 37 `anchorGold` points
 *   are city anchors for "near X" queries, not venue coordinates, so they are not truth here).
 *
 *   `local_coverage_hint` is assigned pre-hoc from the §1 attribution table by (locale, source):
 *   a row drawn from an OpenAddresses dump we import is `OA_point`; GB rows come from an OSM-derived
 *   golden and GB has no OA import, so they are `OSM_address`; venue rows ride on OSM's named
 *   features, also `OSM_address`; admin answers resolve off the WOF hierarchy, so they are
 *   `WOF_only`. `OSM_interpolation` and `TIGER_range` are NOT assigned
 *   pre-hoc: whether a given address is absent from the point layers (and therefore falls through to
 *   an interpolated answer) is a property of the built index, not of the row — it is measured after
 *   the fact from the response, not asserted here.
 *
 *   Usage: node pelias-rig/panel/build-panel.ts
 */

import { createHash } from "node:crypto"
import { createReadStream, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import { titlecaseIfUpper } from "@mailwoman/core"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { mulberry32 } from "@mailwoman/core/utils"
import { pointInMultiPolygon } from "@mailwoman/spatial"
import { FIPSStateCode } from "@mailwoman/tiger"
import { CSVSpliterator, JSONSpliterator } from "spliterator"

/**
 * The one seed. Recorded in the sidecar; a change means a new panel version.
 */
const PANEL_SEED = 20_260_807

const REPO = resolve(import.meta.dirname, "../..")
const EXTERNAL = resolve(REPO, "data/eval/external")
const FIXTURES = resolve(REPO, "mailwoman/eval-harness/fixtures")
const GAUNTLET = resolve(REPO, "mailwoman/eval-harness/gauntlet/cases")
const OA_EXTRACTED = "/mnt/playpen/mailwoman-data/openaddresses/extracted"

//#region Row shape

interface PanelRow {
	id: string
	locale: string
	country: string
	input: string
	truth_lat: number
	truth_lon: number
	truth_type: "rooftop" | "venue" | "city-only"
	local_coverage_hint: "OA_point" | "OSM_address" | "WOF_only"
	tolerance_m: number | null
	source: string
}

//#endregion

//#region IO helpers

function readJSONL<T>(path: string): T[] {
	let text: string

	try {
		text = readFileSync(path, "utf8")
	} catch {
		return []
	}

	return [...JSONSpliterator.from<T>(text)]
}

/**
 * Drop a leading UTF-8 BOM before the CSV reader sees it.
 *
 * Same guard as `scripts/eval/build-oa-coord-golden.ts`: a BOM survives into the FIRST header name (`﻿LON` rather than
 * `LON`), so every row reads that column as absent while the rest parse.
 */
async function* withoutBOM(source: AsyncIterable<Uint8Array | string>): AsyncIterable<Uint8Array> {
	let first = true

	for await (const chunk of source) {
		let bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk

		if (first) {
			first = false

			if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
				bytes = bytes.subarray(3)
			}
		}

		yield bytes
	}
}

//#endregion

//#region Sampling

/**
 * Seeded Fisher-Yates take — stable given a stable input order.
 */
function sample<T>(items: readonly T[], count: number, seed: number): T[] {
	const pool = [...items]
	const rand = mulberry32(seed)

	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
	}

	return pool.slice(0, count)
}

/**
 * Algorithm R over a stream, so a 1.5 GB countrywide CSV is sampled in one pass with country-wide spread rather than
 * taking whichever province leads the file.
 */
async function reservoir<T>(rows: AsyncIterable<T>, count: number, seed: number): Promise<T[]> {
	const rand = mulberry32(seed)
	const held: T[] = []
	let seen = 0

	for await (const row of rows) {
		seen++

		if (held.length < count) {
			held.push(row)

			continue
		}

		const slot = Math.floor(rand() * seen)

		if (slot < count) {
			held[slot] = row
		}
	}

	return held
}

//#endregion

//#region Rooftop sources

interface Components {
	house_number?: string
	street?: string
	postcode?: string
	locality?: string
	region?: string
}

interface CoordGoldenRow {
	raw: string
	components: Components
	country: string
	lat: number
	lon: number
	source?: string
}

/**
 * Street-first postal order: DE, AT, CH, CZ, DK, BE, NL.
 */
function renderStreetFirst(c: Components): string | null {
	if (!c.house_number || !c.street || !c.postcode || !c.locality) return null

	return `${c.street} ${c.house_number}, ${c.postcode} ${c.locality}`
}

/**
 * Number-first with a trailing postcode: FR.
 */
function renderNumberFirst(c: Components): string | null {
	if (!c.house_number || !c.street || !c.postcode || !c.locality) return null

	return `${c.house_number} ${c.street}, ${c.postcode} ${c.locality}`
}

/**
 * Number-first, locality then postcode: GB.
 */
function renderGB(c: Components): string | null {
	if (!c.house_number || !c.street || !c.postcode || !c.locality) return null

	return `${c.house_number} ${c.street}, ${c.locality}, ${c.postcode}`
}

function coordGoldenRows(
	file: string,
	render: (c: Components) => string | null
): { input: string; lat: number; lon: number; country: string; source: string }[] {
	const out: { input: string; lat: number; lon: number; country: string; source: string }[] = []

	readJSONL<CoordGoldenRow>(resolve(EXTERNAL, file)).forEach((row, index) => {
		const input = render(row.components)

		if (!input || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return

		out.push({ input, lat: row.lat, lon: row.lon, country: row.country.toUpperCase(), source: `${file}#${index}` })
	})

	return out
}

/**
 * DE rooftop truth.
 *
 * `openaddresses-de-sample.jsonl` is the only DE source in the repo carrying coordinates, and its `input` is rendered
 * US-style ("27 Straußstraße, Berlin, Berlin 12623") with the street and number fused into the first comma field. Split
 * that field back apart and re-render German order. A row whose first field does not open with a house number is
 * dropped rather than guessed at.
 */
function germanRooftopRows(): { input: string; lat: number; lon: number; country: string; source: string }[] {
	interface SampleRow {
		input: string
		lat: number
		lon: number
		expected?: { locality?: string; postcode?: string }
	}

	const out: { input: string; lat: number; lon: number; country: string; source: string }[] = []
	const file = "openaddresses-de-sample.jsonl"

	readJSONL<SampleRow>(resolve(EXTERNAL, file)).forEach((row, index) => {
		const head = row.input.split(",")[0]?.trim() ?? ""
		const match = /^(\d+\S*)\s+(\p{L}.*)$/u.exec(head)

		if (!match) return

		const input = renderStreetFirst({
			house_number: match[1],
			street: match[2],
			postcode: row.expected?.postcode,
			locality: row.expected?.locality,
		})

		if (!input || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return

		out.push({ input, lat: row.lat, lon: row.lon, country: "DE", source: `${file}#${index}` })
	})

	return out
}

/**
 * US rooftop truth — already in natural US order, and the only source carrying a state code.
 */
function usRooftopRows(): {
	input: string
	lat: number
	lon: number
	country: string
	source: string
	state: string
}[] {
	interface SampleRow {
		input: string
		lat: number
		lon: number
		state?: string
	}

	const out: { input: string; lat: number; lon: number; country: string; source: string; state: string }[] = []
	const file = "openaddresses-us-sample.jsonl"

	readJSONL<SampleRow>(resolve(EXTERNAL, file)).forEach((row, index) => {
		if (!row.input || !Number.isFinite(row.lat) || !Number.isFinite(row.lon) || !row.state) return

		out.push({
			input: row.input,
			lat: row.lat,
			lon: row.lon,
			country: "US",
			source: `${file}#${index}`,
			state: row.state.toUpperCase(),
		})
	})

	return out
}

/**
 * AU and NZ rooftop truth, drawn straight from the OpenAddresses countrywide dumps.
 *
 * Neither country has a usable coordinate golden in the repo: `oa-au-coord-150.jsonl` holds 72 rows (its name
 * overstates it) rendered in European order and carrying no state, and no `oa-nz-coord-*` file exists at all.
 * `build-oa-coord-golden.ts` cannot make one for NZ either — it requires a POSTCODE and the NZ dump ships that column
 * empty, which is why it wrote zero rows when tried. So both are sampled here from the dumps Pelias itself will
 * import.
 */
async function oceaniaRooftopRows(
	cc: "au" | "nz",
	count: number,
	seed: number
): Promise<{ input: string; lat: number; lon: number; country: string; source: string }[]> {
	const path = `${OA_EXTRACTED}/${cc}/countrywide.csv`

	const stream = CSVSpliterator.fromAsync<Record<string, string | undefined>>(withoutBOM(createReadStream(path)), {
		mode: "object",
		normalizeKeys: false,
		enableQuoteHandling: true,
	})

	async function* usable() {
		for await (const row of stream) {
			const num = (row.NUMBER ?? "").trim()
			const street = titlecaseIfUpper((row.STREET ?? "").trim())
			const city = titlecaseIfUpper((row.CITY ?? "").trim())
			const region = (row.REGION ?? "").trim()
			const postcode = (row.POSTCODE ?? "").trim()
			const lat = Number(row.LAT)
			const lon = Number(row.LON)

			if (!num || num === "0" || !street || !city) continue

			if (!/^\p{L}/u.test(street)) continue

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

			// AU writes "51 Grantson Street, Windsor QLD 4030" — the state matters, several
			// localities share a name. NZ writes "26A Henley Road, Kaukapakapa"; its dump carries
			// no postcode, so the locality is the only tail there is.
			if (cc === "au") {
				if (!region || !postcode) continue

				yield { input: `${num} ${street}, ${city} ${region} ${postcode}`, lat, lon }
			} else {
				yield { input: postcode ? `${num} ${street}, ${city} ${postcode}` : `${num} ${street}, ${city}`, lat, lon }
			}
		}
	}

	const held = await reservoir(usable(), count, seed)

	return held.map((row, index) => ({
		input: row.input,
		lat: row.lat,
		lon: row.lon,
		country: cc.toUpperCase(),
		source: `oa:${cc}/countrywide.csv#${index}`,
	}))
}

//#endregion

//#region Board sources (city-only, venue, and a few board rooftops)

interface BoardRow {
	input: string
	country?: string
	locale?: string
	expectLat?: number
	expectLon?: number
	expectToleranceM?: number
	expectComponents?: Record<string, unknown>
}

interface BoardCandidate {
	input: string
	lat: number
	lon: number
	tolerance: number
	source: string
	truthType: "rooftop" | "venue" | "city-only"
}

/**
 * A board row's stratum, read off the components the board itself asserts.
 *
 * Tolerance is NOT the discriminator: the gauntlet grades a named venue at 200 m and a bare city at 25 km, but it also
 * grades some street addresses at 1.5 km, so a tolerance cut would file real rooftops as cities. What the row claims to
 * be is in `expectComponents` — a `venue` key means the query names a place of business, `house_number` + `street`
 * means a point address, and anything else (locality / region / postcode alone) is an admin-level answer.
 */
function boardTruthType(row: BoardRow): "rooftop" | "venue" | "city-only" {
	const components = row.expectComponents ?? {}

	if ("venue" in components) return "venue"

	if ("house_number" in components && "street" in components) return "rooftop"

	return "city-only"
}

/**
 * Every board candidate the repo holds, in stable file order, keyed by country.
 */
function boardRows(): Map<string, BoardCandidate[]> {
	const byCountry = new Map<string, BoardCandidate[]>()

	const push = (row: BoardRow, source: string) => {
		if (!row.input || !row.country) return

		if (!Number.isFinite(row.expectLat) || !Number.isFinite(row.expectLon)) return

		const cc = row.country.toUpperCase()
		const list = byCountry.get(cc) ?? []

		list.push({
			input: row.input,
			lat: row.expectLat!,
			lon: row.expectLon!,
			tolerance: row.expectToleranceM ?? 25_000,
			source,
			truthType: boardTruthType(row),
		})

		byCountry.set(cc, list)
	}

	readJSONL<BoardRow>(resolve(FIXTURES, "hard-slice-board.jsonl")).forEach((row, index) =>
		push(row, `hard-slice-board.jsonl#${index}`)
	)

	readJSONL<BoardRow>(resolve(GAUNTLET, "generalization/country-sweep-2026-08-05-passes.jsonl")).forEach((row, index) =>
		push(row, `country-sweep-2026-08-05-passes.jsonl#${index}`)
	)

	for (const cc of PANEL_COUNTRIES) {
		readJSONL<BoardRow>(resolve(GAUNTLET, cc.toLowerCase(), "regression.jsonl")).forEach((row, index) =>
			push(row, `gauntlet/${cc.toLowerCase()}/regression.jsonl#${index}`)
		)
	}

	return byCountry
}

//#endregion

//#region The panel definition

const PANEL_COUNTRIES = ["US", "FR", "DE", "GB", "AU", "NZ", "AT", "CH", "CZ", "DK", "BE", "NL"] as const

interface LocaleSpec {
	locale: string
	countries: readonly string[]
	rooftopTarget: number
	cityTarget: number
	total: number
}

/**
 * 60 rows per locale, aiming at 45 rooftop / 15 city-only.
 *
 * Where the city-only pool is smaller than 15 (DE, AU, NZ hold very few board rows), the deficit is taken from the
 * rooftop pool so the locale still carries 60 — the strata are reported separately, so a 56/4 locale is legible as long
 * as the mix is written down, which the summary does. Where BOTH pools are short the locale simply lands under 60 and
 * the shortfall is recorded; nothing is padded or duplicated.
 */
const LOCALES: LocaleSpec[] = [
	{ locale: "en-us", countries: ["US"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "fr-fr", countries: ["FR"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "de-de", countries: ["DE"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "en-gb", countries: ["GB"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "en-au", countries: ["AU"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "en-nz", countries: ["NZ"], rooftopTarget: 45, cityTarget: 15, total: 60 },
	{ locale: "eu-mixed", countries: ["AT", "CH", "CZ", "DK", "BE", "NL"], rooftopTarget: 45, cityTarget: 15, total: 60 },
]

/**
 * The EU-panel rooftop draw, per country: 8+8+8+7+7+7 = 45.
 */
const EU_ROOFTOP_FILES: [country: string, file: string, count: number][] = [
	["AT", "oa-at-coord-150.jsonl", 8],
	["CH", "oa-ch-coord-1k.jsonl", 8],
	["CZ", "oa-cz-coord-1k.jsonl", 8],
	["DK", "oa-dk-coord-1k.jsonl", 7],
	["BE", "oa-be-coord-1k.jsonl", 7],
	["NL", "oa-nl-coord-1k.jsonl", 7],
]

//#endregion

//#region US state resolution

/**
 * Which US states the panel touches — read off the TRUTH COORDINATES, not off a name string.
 *
 * `@mailwoman/tiger`'s nation GeometryCollection is keyed by state FIPS, so a point-in-polygon over it answers
 * directly; `FIPSStateCode` inverts FIPS back to the postal abbreviation and `US_STATE_BY_ABBREVIATION` gives the full
 * name the Geofabrik URL wants.
 */
function usStatesFor(points: { lat: number; lon: number }[]): { abbreviation: string; fips: string; name: string }[] {
	const nationPath = resolve(REPO, "tiger/sdk/data/nation/index.json")

	const nation = parseJSONStrict<{
		geometries: { id: string; type: string; coordinates: number[][][][] }[]
	}>(readFileSync(nationPath, "utf8"))

	const fipsToAbbreviation = new Map(Object.entries(FIPSStateCode).map(([abbreviation, fips]) => [fips, abbreviation]))
	const found = new Map<string, { abbreviation: string; fips: string; name: string }>()

	for (const point of points) {
		for (const geometry of nation.geometries) {
			if (!pointInMultiPolygon(point.lon, point.lat, geometry.coordinates as never)) continue

			const abbreviation = fipsToAbbreviation.get(geometry.id)

			if (!abbreviation) break

			found.set(geometry.id, {
				abbreviation,
				fips: geometry.id,
				name: (US_STATE_BY_ABBREVIATION as Record<string, string>)[abbreviation] ?? abbreviation,
			})

			break
		}
	}

	return [...found.values()].toSorted((a, b) => a.fips.localeCompare(b.fips))
}

//#endregion

//#region Build

const rooftopByLocale = new Map<
	string,
	{ input: string; lat: number; lon: number; country: string; source: string; state?: string }[]
>([
	["en-us", usRooftopRows()],
	["fr-fr", coordGoldenRows("oa-fr-coord-150.jsonl", renderNumberFirst)],
	["de-de", germanRooftopRows()],
	["en-gb", coordGoldenRows("oa-gb-coord-1k.jsonl", renderGB)],
	["en-au", await oceaniaRooftopRows("au", 200, PANEL_SEED + 1)],
	["en-nz", await oceaniaRooftopRows("nz", 200, PANEL_SEED + 2)],
])

const cityPool = boardRows()
const panel: PanelRow[] = []

const summary: Record<string, { rooftop: number; venue: number; cityOnly: number; total: number; note?: string }> = {}
const seen = new Set<string>()

for (const [index, spec] of LOCALES.entries()) {
	const cityCandidates = spec.countries.flatMap((cc) =>
		(cityPool.get(cc) ?? []).map((row) => ({ ...row, country: cc }))
	)

	const cityDraw = sample(cityCandidates, spec.cityTarget, PANEL_SEED + 100 + index)
	const rooftopWanted = spec.total - cityDraw.length

	let rooftopDraw: { input: string; lat: number; lon: number; country: string; source: string; state?: string }[]

	if (spec.locale === "eu-mixed") {
		rooftopDraw = EU_ROOFTOP_FILES.flatMap(([, file, count], fileIndex) =>
			sample(coordGoldenRows(file, renderStreetFirst), count, PANEL_SEED + 200 + fileIndex)
		)

		// Any deficit from a short city draw is spread over the same six files, largest first.
		if (rooftopDraw.length < rooftopWanted) {
			const extra = sample(
				EU_ROOFTOP_FILES.flatMap(([, file]) => coordGoldenRows(file, renderStreetFirst)),
				rooftopWanted - rooftopDraw.length,
				PANEL_SEED + 299
			)

			rooftopDraw = [...rooftopDraw, ...extra]
		}
	} else {
		rooftopDraw = sample(rooftopByLocale.get(spec.locale) ?? [], rooftopWanted, PANEL_SEED + 300 + index)
	}

	let n = 0

	for (const row of [...rooftopDraw, ...cityDraw]) {
		const key = `${row.country}|${row.input.toLowerCase()}`

		if (seen.has(key)) continue

		seen.add(key)

		const fromBoard = "tolerance" in row
		const truthType = fromBoard ? (row as BoardCandidate).truthType : "rooftop"

		// A point address is expected to answer from the point layer we imported for that country
		// (OA everywhere but GB, which has no OA import and rides on OSM address nodes); a named
		// venue answers from OSM's named features; an admin-level answer comes off the WOF
		// hierarchy. See the header on why TIGER_range and OSM_interpolation are not assigned here.
		const pointHint = spec.locale === "en-gb" ? "OSM_address" : "OA_point"

		panel.push({
			id: `${spec.locale}-${String(++n).padStart(3, "0")}`,
			locale: spec.locale,
			country: row.country,
			input: row.input,
			truth_lat: row.lat,
			truth_lon: row.lon,
			truth_type: truthType,
			local_coverage_hint: truthType === "city-only" ? "WOF_only" : truthType === "venue" ? "OSM_address" : pointHint,
			tolerance_m: fromBoard ? (row as BoardCandidate).tolerance : null,
			source: row.source,
		})
	}

	const rows = panel.filter((row) => row.locale === spec.locale)

	summary[spec.locale] = {
		rooftop: rows.filter((row) => row.truth_type === "rooftop").length,
		venue: rows.filter((row) => row.truth_type === "venue").length,
		cityOnly: rows.filter((row) => row.truth_type === "city-only").length,
		total: rows.length,
	}
}

const panelPath = resolve(import.meta.dirname, "panel-v1.jsonl")
const body = panel.map((row) => JSON.stringify(row)).join("\n") + "\n"

writeFileSync(panelPath, body)

const digest = createHash("sha256").update(body).digest("hex")

const usStates = usStatesFor(
	panel.filter((row) => row.country === "US").map((row) => ({ lat: row.truth_lat, lon: row.truth_lon }))
)

/**
 * The states whose LOCAL SOURCES the build actually has to fetch.
 *
 * Every US panel row lands in some state, but a `city-only` row is answered by the WOF admin hierarchy, which the
 * whosonfirst importer loads country-wide from one `countryCode: ["US", …]` download — no state PBF, no TIGER county,
 * no OA state directory. Only the point-bearing rows (`rooftop` / `venue`) need per-state OSM, TIGER and OpenAddresses.
 * Measured on panel v1 the two lists differ sharply: 17 states across all rows, 7 across the point rows — so scoping
 * the fetch to the point rows is what keeps "US = panel states only" from quietly becoming most of the country.
 */
const usStatesRequiringLocalSources = usStatesFor(
	panel
		.filter((row) => row.country === "US" && row.truth_type !== "city-only")
		.map((row) => ({ lat: row.truth_lat, lon: row.truth_lon }))
)

const usStatesFromField = [
	...new Set(
		(rooftopByLocale.get("en-us") ?? [])
			.filter((row) => panel.some((panelRow) => panelRow.source === row.source))
			.map((row) => row.state!)
	),
].toSorted()

const sidecar = {
	panel: "panel-v1.jsonl",
	sha256: digest,
	rows: panel.length,
	seed: PANEL_SEED,
	builtBy: "pelias-rig/panel/build-panel.ts",
	perLocale: summary,
	usStates,
	usStatesRequiringLocalSources,
	usStatesFromRowField: usStatesFromField,
	truthTypes: {
		rooftop: panel.filter((row) => row.truth_type === "rooftop").length,
		venue: panel.filter((row) => row.truth_type === "venue").length,
		"city-only": panel.filter((row) => row.truth_type === "city-only").length,
	},
}

writeFileSync(resolve(import.meta.dirname, "panel-v1.jsonl.sha256"), `${digest}  panel-v1.jsonl\n`)
writeFileSync(resolve(import.meta.dirname, "panel-v1.manifest.json"), JSON.stringify(sidecar, null, "\t") + "\n")

process.stdout.write(JSON.stringify(sidecar, null, 2) + "\n")

//#endregion
