/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the postcode→anchor lookup for the de-risk pilot (#239/#240).
 *
 *   Emits a JSON `{normalized_postcode: [posterior_dict, lat, lon, source]}` for the pilot locales
 *   (DE/FR/US), loaded once at training-loader init (`data.anchor_lookup_path`) so the training
 *   loop carries no gazetteer dependency. This is the offline, deterministic precompute DeepSeek
 *   recommended.
 *
 *   - **posterior**: UNIFORM over the countries whose postal gazetteer contains the code (the posterior
 *       the A/B measurement settled on —
 *       `docs/articles/evals/calibration/2026-06-05-postcode-posterior-ab.md`). A German PLZ that collides with
 *       a US ZIP (e.g. 10115) comes back `{"DE": 0.5, "US": 0.5}`.
 *   - **centroid**: taken from the first source that has a real centroid, in DE→FR→US order, so the
 *       collapse-relevant European rows get a European centroid on a collision. The centroid is the
 *       secondary signal (the posterior + the categorical anchor cue do the work).
 *   - **source** (#525, the provenance-first rule): names the dataset the centroid came from — `wof`
 *       (our WOF postcode databases, which may carry provenanced backfills; see the `centroid_source`
 *       table), `census-zcta-2024` (Census ZCTA Gazetteer fill, either already in the DB or joined
 *       here via `--zcta`), or `null` for a placeholder (membership only).
 *
 *   Sources (build-from-source, never prebuilt): postalcode-intl.db (DE/FR/ES/IT, inline centroids),
 *   postalcode-us.db (US; spr centroids are real post-backfill), postalcode-gb-codepoint.db (GB, OS
 *   Code-Point Open under OGL v3), postalcode-nl-pc6.db (NL, CBS PC6 via PDOK under CC-BY 4.0).
 *
 *   ZCTA caveat: ZCTAs approximate delivery areas, not ZIPs — PO-box-only/unique ZIPs have no ZCTA
 *   and stay placeholder. Vintage + URL: $MAILWOMAN_DATA_ROOT/census/README.md.
 *
 *   Usage: node scripts/build-pilot-anchor-lookup.ts\
 *   --zcta $MAILWOMAN_DATA_ROOT/census/2024_Gaz_zcta_national.txt\
 *   --output $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json
 *
 *   THE LETTER-BEARING HOLE (2026-08-05, `docs/records/evals/2026-08-05-en-gb-anchor-off.md`). The
 *   pilot set is DE/FR/US only, and every one of its 67,708 keys is five digits — ZERO letter-bearing.
 *   The encoder's anchor input reserves one slot per country (`neural/anchor-inference.ts`'s
 *   `LOCALE_ORDER = [US, FR, DE, CA, GB, JP, ES, IT, NL]`), so slots 3–8 took NO gradient across every
 *   run in the tree: a GB outward code is letter-bearing by construction and could never appear as a
 *   key. Shipping `postcode-gb.bin` at inference then fed slot 4 a value the model had never seen, and
 *   cost 24 exact postcodes on the 120-row gb-golden board. `--include` is the cure — it widens the key
 *   set so the letter-bearing systems get a gradient at all. Widening the lookup ALONE is not enough:
 *   the retrain must ride with the inference-side parity fix (`buildAnchorFeatures`'s
 *   `spanMode: "shaped"`), because the default inference scan keys on `[A-Za-z0-9]+` runs and so can
 *   never produce the space-stripped `SW1A2AA` key the train painter writes.
 *
 *   KEY NORMALIZATION IS THE CONTRACT. `mailwoman_train/tokenizer.py::_paint_anchor_chars` looks up
 *   `raw[begin:end].replace(" ", "").upper()`. So every key here is the SPACE-STRIPPED, UPPERCASE
 *   surface: GB `SW1A 2AA` → `SW1A2AA`, NL `1012 LG` → `1012LG`. A key with a space in it can never be
 *   read. The databases already store exactly that form (`#920`'s sanitized-query token shape), so the
 *   loaders below pass `name` through unchanged.
 *
 *   PORT NOTE (from scripts/build-pilot-anchor-lookup.py): faithful TypeScript port. The output is a
 *   JSON file written DIRECTLY to `--output` (no DB, no temp-then-move; matches the Python). The
 *   serializer reproduces Python's `json.dumps(..., ensure_ascii=False)` formatting (", " / ": "
 *   separators, integer-valued floats rendered with a trailing `.0`) so the emitted file matches
 *   the original. The WOF data root is resolved through `dataRootPath` (the one home for the
 *   `/mnt/playpen` default) instead of the Python's hardcoded literal — identical default path, now
 *   also `$MAILWOMAN_DATA_ROOT` overridable.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { finished, openWriteStream } from "@mailwoman/core/fs/streams"
import { dataRootPath, pyFloat, pyRound } from "@mailwoman/core/utils"
import { once } from "@mailwoman/core/utils/events"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { TSVSpliterator } from "spliterator"

/**
 * Digit at which a fractional remainder is exactly half. Above it the value rounds up; at it the tie is broken toward
 * even, which is what keeps repeated centroid rounding unbiased.
 */
/**
 * Columns a US Census gazetteer row carries; short rows are truncated and skipped.
 */
const GAZETTEER_ROW_COLUMNS = 7

/**
 * Keep in sync with scripts/zcta-centroids.ts.
 */
const ZCTA_SOURCE = "census-zcta-2024"

/**
 * (lat, lon, source): source is null when the row is a placeholder (membership only).
 */
type Centroid = [number, number, string | null]

function fiveDigit(name: string | null | undefined): string | null {
	const n = (name || "").trim().toUpperCase()

	return /^[0-9]{5}$/.test(n) ? n : null
}

function placed(lat: number, lon: number): boolean {
	return lat !== 0 || lon !== 0
}

/**
 * DE/FR postcodes → centroid from postalcode-intl.db (inline lat/lon).
 */
function loadIntl(country: string): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(dataRootPath("wof", "postalcode-intl.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND country=?")
		.all(country) as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = fiveDigit(row.name)

		if (pc) {
			const lat = Number(row.latitude)
			const lon = Number(row.longitude)
			out.set(pc, [lat, lon, placed(lat, lon) ? "wof" : null])
		}
	}

	return out
}

/**
 * US postcodes → spr centroid, with per-row provenance from `centroid_source` when present (rows the ZCTA fill placed
 * carry `census-zcta-2024`; untracked placed rows are `wof`).
 */
function loadUs(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(dataRootPath("wof", "postalcode-us.db"))
	const hasSources = con.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='centroid_source'").get()
	const srcJoin = hasSources ? "LEFT JOIN centroid_source cs ON cs.id=spr.id" : ""
	const srcCol = hasSources ? "cs.source" : "NULL"

	const rows = con
		.prepare(
			`SELECT spr.name, spr.latitude, spr.longitude, ${srcCol} AS src FROM spr ${srcJoin} ` +
				"WHERE spr.placetype='postalcode' AND spr.is_current!=0"
		)
		.all() as Array<{ name: string; latitude: number; longitude: number; src: string | null }>

	for (const row of rows) {
		const pc = fiveDigit(row.name)

		if (pc) {
			const lat = Number(row.latitude)
			const lon = Number(row.longitude)
			out.set(pc, [lat, lon, placed(lat, lon) ? row.src || "wof" : null])
		}
	}

	return out
}

/**
 * A GB unit postcode in the space-stripped key form the train painter writes: outward (`SW1A`) glued to inward (`2AA`).
 * Code-Point Open already stores `name` in exactly this shape, so this is a validation filter rather than a transform —
 * it drops anything that would key a span the inference-side shape detector could never produce.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * A GB unit's inward code is ALWAYS the last three characters (`\d[A-Z]{2}`) — the outward district is everything
 * before it. Structural, not a guess; it is the same split `neural/postcode-anchor.ts::gbOutwardCode` makes on the
 * spaced form.
 */
const GB_INWARD_LENGTH = 3

/**
 * An NL PC6 key: four digits glued to two letters (`1012LG`). The CBS database stores the normalized form as `name` and
 * the display form (`1012 LG`) as an alt `names` row; the painter only ever sees the normalized one.
 */
const NL_PC6_KEY = /^\d{4}[A-Z]{2}$/

/**
 * A key carrying at least one letter. The pilot lookup's count is ZERO, which is the whole GB diagnosis in one number —
 * so the builder reports it on every run.
 */
const LETTER_BEARING = /[A-Z]/

/**
 * Centroid-provenance labels for the sources this builder reaches beyond `wof` (#525, the provenance-first rule).
 */
const GB_SOURCE = "os-codepoint-open"
const GB_OUTWARD_SOURCE = "os-codepoint-open-outward"
const NL_SOURCE = "cbs-pc6"

/**
 * GB unit postcodes → centroid from `postalcode-gb-codepoint.db` (Ordnance Survey Code-Point Open, OGL v3.0 — 1,746,976
 * units, every one placed; the database's `meta` carries the full attribution string that must accompany any
 * redistribution). This is the LICENCE-CLEAN GB source: the retired GeoNames GB rows are not it, and Overture has no GB
 * postcodes at all. Coverage gap, measured not assumed: ZERO Northern Ireland (BT) codes — Code-Point Open is
 * England/Scotland/Wales only, and NI postcode geography is LPS-licensed (see the database's
 * `coverage_gap_northern_ireland_options`).
 */
function loadGBCodePoint(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(dataRootPath("wof", "postalcode-gb-codepoint.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND is_current!=0")
		.all() as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = (row.name || "").trim().toUpperCase()

		if (!GB_UNIT_KEY.test(pc)) continue
		const lat = Number(row.latitude)
		const lon = Number(row.longitude)

		out.set(pc, [lat, lon, placed(lat, lon) ? GB_SOURCE : null])
	}

	return out
}

/**
 * Add the GB outward-district keys (`SW1A`) alongside the unit keys already in `units`, each placed at the MEAN of its
 * units' centroids. Two consumers want them, and neither is the common path:
 *
 * - The inference parity fix's outward fallback — a unit that misses (a new-build code, or an NI `BT` code Code-Point
 *   Open does not carry) still anchors its FULL span from the district;
 * - A bare outward code in the text, which the train painter never looks up (`collect_matches`'s GB pattern requires the
 *   inward half) but the DEFAULT alnum-run inference scan does.
 *
 * Outward keys cannot collide with anything else in the lookup: they are letter-initial and ≤4 chars, unit keys are ≥5,
 * NL keys are digit-initial, and every numeric system's keys are digits only.
 */
function addGBOutwardKeys(units: Map<string, Centroid>): number {
	const acc = new Map<string, { lat: number; lon: number; n: number }>()

	for (const [pc, [lat, lon, source]] of units) {
		if (source === null) continue
		const outward = pc.slice(0, -GB_INWARD_LENGTH)
		const bucket = acc.get(outward)

		if (bucket) {
			bucket.lat += lat
			bucket.lon += lon

			bucket.n++
		} else {
			acc.set(outward, { lat, lon, n: 1 })
		}
	}

	for (const [outward, { lat, lon, n }] of acc) {
		units.set(outward, [lat / n, lon / n, GB_OUTWARD_SOURCE])
	}

	return acc.size
}

/**
 * NL PC6 postcodes → centroid from `postalcode-nl-pc6.db` (CBS "Postcode6 statistieken" via PDOK, CC-BY 4.0 — 464,964
 * codes, every one placed). WOF carries no NL `postalcode` tier at all, which is why this is a separate database;
 * `postalcode-intl.db` also holds 371,628 GeoNames-lineage NL rows, and the CBS database is both larger and built from
 * polygon centroids, so it wins.
 */
function loadNLPC6(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	using con = new DatabaseClient<WOFDatabase>(dataRootPath("wof", "postalcode-nl-pc6.db"))

	const rows = con
		.prepare("SELECT name, latitude, longitude FROM spr WHERE placetype='postalcode' AND is_current!=0")
		.all() as Array<{ name: string; latitude: number; longitude: number }>

	for (const row of rows) {
		const pc = (row.name || "").trim().toUpperCase()

		if (!NL_PC6_KEY.test(pc)) continue
		const lat = Number(row.latitude)
		const lon = Number(row.longitude)

		out.set(pc, [lat, lon, placed(lat, lon) ? NL_SOURCE : null])
	}

	return out
}

/**
 * Census ZCTA Gazetteer file → 5-digit code → internal-point centroid (mirror of
 * scripts/zcta-centroids.ts::parseZCTACentroids).
 */
async function loadZCTA(path: string): Promise<Map<string, [number, number]>> {
	const out = new Map<string, [number, number]>()

	for (const row of TSVSpliterator.from(await readLocalTextFile(path), { header: false })) {
		const fields = row.map((f) => f.trim())
		const pc = fields.length ? fiveDigit(fields[0]) : null

		if (!pc || fields.length < GAZETTEER_ROW_COLUMNS) continue
		const lat = pyFloat(fields[5])
		const lon = pyFloat(fields[6])

		if (lat === null || lon === null) continue

		if (placed(lat, lon)) {
			out.set(pc, [lat, lon])
		}
	}

	return out
}

/**
 * Python `ensure_ascii=False` JSON string escape (quote, backslash, control chars).
 */
function pyJSONStr(s: string): string {
	let out = '"'

	for (const ch of s) {
		const code = ch.codePointAt(0)!

		if (ch === '"') {
			out += '\\"'
		} else if (ch === "\\") {
			out += "\\\\"
		} else if (ch === "\n") {
			out += "\\n"
		} else if (ch === "\r") {
			out += "\\r"
		} else if (ch === "\t") {
			out += "\\t"
		} else if (code < 0x20) {
			out += "\\u" + code.toString(16).padStart(4, "0")
		} else {
			out += ch
		}
	}

	return out + '"'
}

/**
 * Python `repr`/`json` of a float — shortest round-trip, but integer-valued renders with `.0`.
 */
function pyJSONNum(x: number): string {
	if (Number.isInteger(x)) return Object.is(x, -0) ? "-0.0" : `${x}.0`

	return String(x)
}

/**
 * Serialize one lookup value `[posterior, lat, lon, source]` the way Python `json.dumps` would.
 */
function pyJSONValue(v: unknown): string {
	if (v === null) return "null"

	if (typeof v === "number") return pyJSONNum(v)

	if (typeof v === "string") return pyJSONStr(v)

	if (Array.isArray(v)) return "[" + v.map(pyJSONValue).join(", ") + "]"
	const parts: string[] = []

	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		parts.push(pyJSONStr(k) + ": " + pyJSONValue(val))
	}

	return "{" + parts.join(", ") + "}"
}

type LookupRow = [Record<string, number>, number, number, string | null]

/**
 * The pilot country set — DE/FR/US, the ONLY set any config in `mailwoman_train/configs/` has ever trained against.
 * Every key it produces is five digits. This is the default so an argument-free build stays byte-identical to the
 * shipped `pilot-anchor-lookup.json` recipe.
 */
export const ANCHOR_PILOT_COUNTRIES = ["DE", "FR", "US"] as const

/**
 * The v2 country set (2026-08-05) — the pilot three plus every country with a licence-clean postcode source and a slot
 * in `LOCALE_ORDER`: GB (Code-Point Open, OGL v3), NL (CBS PC6, CC-BY 4.0), ES + IT (GeoNames-lineage rows in
 * `postalcode-intl.db`, CC-BY 4.0). ORDER IS CENTROID PRIORITY, and the pilot three lead so a 5-digit code that already
 * had a DE/FR/US centroid keeps it verbatim; ES/IT only ever ADD posterior mass and fill placeholders.
 *
 * Not here, and why: **CA** (slot 3) — the built centroids live in `postalcode-ca-overture.db`, an Overture-derived
 * artifact (ODbL) that is build-local, not a redistributable training input. **JP** (slot 5) — `postalcode-jp.db`
 * exists, but a JP code is `\d{3}-\d{4}`, whose key form (`1000001`) collides shape-wise with nothing yet in the set
 * and needs its own confound board before it feeds a channel. **NI (`BT`) GB codes** — Code-Point Open carries zero of
 * them and the only sources that do are LPS-licensed or ODbL (`postalcode-ni-osm.db`, build-local tier).
 */
export const ANCHOR_V2_COUNTRIES = ["DE", "FR", "US", "GB", "NL", "ES", "IT"] as const

/**
 * Per-country centroid loaders. A country's presence here is what makes it selectable via
 * {@linkcode AnchorLookupOptions.include}.
 */
const COUNTRY_LOADERS: Record<string, () => Map<string, Centroid>> = {
	DE: () => loadIntl("DE"),
	ES: () => loadIntl("ES"),
	FR: () => loadIntl("FR"),
	GB: loadGBCodePoint,
	IT: () => loadIntl("IT"),
	NL: loadNLPC6,
	US: loadUs,
}

/**
 * Flush the output string every this many entries. The v2 set is ~2.2M keys / ~170 MB of JSON; accumulating that as one
 * `Array.join` peaked well past a gigabyte, so the serializer streams instead. 4,096 keeps the intermediate string in
 * the low hundreds of KB.
 */
const WRITE_FLUSH_ENTRIES = 4096

export interface AnchorLookupOptions {
	output: string
	zcta?: string
	/**
	 * Country codes to include, in centroid-priority order. Defaults to {@linkcode ANCHOR_PILOT_COUNTRIES}; pass
	 * {@linkcode ANCHOR_V2_COUNTRIES} (or a subset) to widen the key set. Every code must have a loader.
	 */
	include?: readonly string[]
	/**
	 * Emit GB outward-district keys beside the unit keys (see {@linkcode addGBOutwardKeys}). Defaults to `true` whenever
	 * GB is included; ignored otherwise.
	 */
	gbOutward?: boolean
}

/**
 * What a build produced — returned so a caller (a command, a test, a stats table) can assert on it instead of parsing
 * the log line.
 */
export interface AnchorLookupStats {
	/**
	 * Total keys written.
	 */
	total: number
	/**
	 * Keys naming each country in their posterior. A collision counts in every member country.
	 */
	byCountry: Record<string, number>
	/**
	 * Keys carrying at least one `A-Z` character — the count the GB hole was measured by (the pilot lookup's is 0).
	 */
	letterBearing: number
	/**
	 * Keys whose posterior names more than one country.
	 */
	collisions: number
	/**
	 * GB outward-district keys included in the total (0 when GB is out or `gbOutward` is false).
	 */
	gbOutwardKeys: number
	/**
	 * Keys per centroid-provenance label; `null` is the placeholder (membership only, no centroid).
	 */
	bySource: Map<string | null, number>
	/**
	 * Keys the `--zcta` join placed during THIS build.
	 */
	zctaFilled: number
}

export async function buildAnchorLookup(args: AnchorLookupOptions): Promise<AnchorLookupStats> {
	const countries = (args.include?.length ? args.include : ANCHOR_PILOT_COUNTRIES).map((c) => c.toUpperCase())

	for (const country of countries) {
		if (!COUNTRY_LOADERS[country]) {
			throw new Error(`No anchor-lookup loader for ${country} (have: ${Object.keys(COUNTRY_LOADERS).join(", ")})`)
		}
	}

	// centroid priority order
	const sources: Array<[string, Map<string, Centroid>]> = countries.map((c) => [c, COUNTRY_LOADERS[c]!()])
	let gbOutwardKeys = 0

	if (countries.includes("GB") && args.gbOutward !== false) {
		gbOutwardKeys = addGBOutwardKeys(sources.find(([c]) => c === "GB")![1])
	}

	const zcta = args.zcta ? await loadZCTA(args.zcta) : new Map<string, [number, number]>()
	const allCodes = new Set<string>()

	for (const [, d] of sources) {
		for (const k of d.keys()) {
			allCodes.add(k)
		}
	}

	const sortedCodes = [...allCodes].toSorted()
	const byCountry: Record<string, number> = Object.fromEntries(countries.map((c) => [c, 0]))
	const bySource = new Map<string | null, number>()
	let collisions = 0
	let zctaFilled = 0
	let letterBearing = 0

	// Serialize from the SORTED key array, streaming: JS hoists integer-like string keys (e.g. "10000")
	// ahead of insertion order, so an object's own iteration order would unsort the output — and at the
	// v2 set's ~2.2M keys, materializing every row before writing costs more memory than the build.
	const output = openWriteStream(args.output)
	let buffer = "{"
	let written = 0

	for (const pc of sortedCodes) {
		const members = sources.filter(([, d]) => d.has(pc)).map(([c]) => c)
		const k = members.length
		const posterior: Record<string, number> = {}

		for (const c of members) {
			posterior[c] = 1 / k

			byCountry[c]!++
		}

		if (k > 1) {
			collisions++
		}

		if (LETTER_BEARING.test(pc)) {
			letterBearing++
		}

		// centroid: the first source in `include` order with a non-zero centroid; never overwritten by ZCTA.
		let lat = 0
		let lon = 0
		let source: string | null = null

		for (const [, d] of sources) {
			const c = d.get(pc)

			if (c && placed(c[0], c[1])) {
				;[lat, lon, source] = c

				break
			}
		}

		// ZCTA fill: placeholders only, US members only (#525).
		if (source === null && members.includes("US") && zcta.has(pc)) {
			;[lat, lon] = zcta.get(pc)!
			source = ZCTA_SOURCE

			zctaFilled++
		}

		const row: LookupRow = [posterior, pyRound(lat, 5), pyRound(lon, 5), source]

		bySource.set(source, (bySource.get(source) ?? 0) + 1)

		buffer += (written ? ", " : "") + pyJSONStr(pc) + ": " + pyJSONValue(row)

		written++

		if (written % WRITE_FLUSH_ENTRIES === 0) {
			// Backpressure honoured explicitly. `writeSync` blocked, which bounded memory for free; a stream buffers
			// whatever it is handed, and at ~2.2M keys that is the cost this loop exists to avoid.
			if (!output.write(buffer)) {
				await once(output, "drain")
			}

			buffer = ""
		}
	}

	output.end(buffer + "}")
	await finished(output)

	const placeholders = bySource.get(null) ?? 0

	// Python repr of `{k or 'placeholder': n for k, n in sorted(by_source.items(), key=lambda kv: -kv[1])}`.
	const sourceRepr =
		"{" +
		[...bySource.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.map(([k, n]) => `'${k ?? "placeholder"}': ${n}`)
			.join(", ") +
		"}"

	const total = sortedCodes.length

	console.log(
		`${total.toLocaleString("en-US")} postcodes → ${args.output}  ` +
			`(${countries.map((c) => `${c} ${byCountry[c]!.toLocaleString("en-US")}`).join(", ")}; ` +
			`${letterBearing.toLocaleString("en-US")} letter-bearing; ` +
			`${gbOutwardKeys.toLocaleString("en-US")} GB outward; ` +
			`${collisions.toLocaleString("en-US")} collisions; ` +
			`${zctaFilled.toLocaleString("en-US")} ZCTA-filled here; sources ${sourceRepr}; ` +
			`${placeholders.toLocaleString("en-US")} no-centroid = ${((100 * placeholders) / total).toFixed(1)}%)`
	)

	return { total, byCountry, letterBearing, collisions, gbOutwardKeys, bySource, zctaFilled }
}
