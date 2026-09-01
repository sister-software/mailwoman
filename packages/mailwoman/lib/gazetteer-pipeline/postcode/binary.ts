/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The PCB1 postcode-binary derivation, extracted from `mailwoman/commands/gazetteer/postcode-binary.tsx`
 *   so it can be tested without a database and a terminal (#1509).
 *
 *   WHY IT MOVED. The command's GB branch derived the outward district by splitting `name` on a SPACE.
 *   That was written against `postalcode-gb.db` (the retired GeoNames-lineage database), whose `name`
 *   carries the spaced display form. The licence-clean Code-Point Open database
 *   (`postalcode-gb-codepoint.db`, OGL v3.0) stores `name` ALREADY space-stripped (`AB101AB`), so the
 *   split returned null on every one of its 1,746,976 rows and the command wrote a structurally-valid,
 *   ZERO-key binary and exited 0. Measured 2026-08-05:
 *
 *     mailwoman gazetteer postcode-binary --locale GB:postalcode-gb-codepoint.db
 *       → GB: 0 codes (0 placed) → postcode-gb.bin (0.00 MB)   [exit 0]
 *
 *   Both halves of the cure live here. {@linkcode gbOutwardFromKey} derives the outward by SHAPE — the
 *   inward code is always the trailing three characters of the space-stripped form, so the same rule
 *   reads both databases. {@linkcode keyFloorViolation} makes an empty or catastrophically-degraded build
 *   a REFUSAL: a magnitude never carries its own absence, so zero keys is a failure, not a product.
 *
 *   The GB key set is a deliberate mirror of the TRAINING lookup's GB half
 *   (`mailwoman/gazetteer-pipeline/anchor-lookup.ts::loadGBCodePoint` + `addGBOutwardKeys`): every unit
 *   that matches the unit-key shape, plus one outward key per district placed at the MEAN of its PLACED
 *   units' centroids. Decoded through `PostcodeBinaryResolver.toAnchorLookup()` that reproduces the
 *   training lookup's GB entries up to the format's i16 centroid quantization (~300 m).
 */

import type { PostcodeBinaryEntry } from "@mailwoman/neural/postcode"

/**
 * A GB unit postcode in the SPACE-STRIPPED key form the train painter writes (`SW1A2AA`) — outward glued to inward.
 * Verbatim from `anchor-lookup.ts`; keep the three copies (here, `anchor-lookup.ts`, `neural/anchor-inference.ts`) in
 * lockstep, they are the same contract read from three sides.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * A GB unit's inward code is ALWAYS the last three characters (`\d[A-Z]{2}`); the outward district is everything before
 * it. Structural, not a guess — and unlike a space split it holds on a database that stores the glued form.
 */
const GB_INWARD_LENGTH = 3

/**
 * GB key granularity. `unit` is the TRAIN-FAITHFUL set the anchor-v2 lookup carries (1,746,976 units + 2,863 outward
 * districts = 1,749,839 keys, 20.0 MB) — the unit centroid is what painted the training spans, so a model trained
 * against `pilot-anchor-lookup-v2` needs it. `outward` is the districts alone (2,863 keys, 0.03 MB), which is the only
 * thing that fits a browser bundle; it was the command's original behaviour and stays available for that reason.
 */
export type GBGranularity = "unit" | "outward"

/**
 * One country's PCB1 source: the WOF postcode database its rows are read from, and the coarsest key set a browser
 * bundle can carry when the train-faithful set cannot.
 */
export interface PostcodeBinarySource {
	/**
	 * ISO 3166-1 alpha-2, upper-case — the `country` the database's `spr` rows are filtered on.
	 */
	country: string
	/**
	 * Database filename under `<data-root>/wof/`.
	 */
	database: string
	/**
	 * The granularity a browser asset dir should hold, when the train-faithful build is too large for one. Absent for a
	 * country whose full key set already fits — the size note the command prints is keyed on this, not on the country.
	 */
	browserGranularity?: GBGranularity
}

/**
 * The per-country sources `mailwoman gazetteer postcode-binary` builds by default, in emission order. Shared with the
 * `--locale <CC>:<db>` override path only through {@linkcode PostcodeBinarySource.browserGranularity}: an override
 * replaces the DATABASE, never the country's browser rule.
 *
 * Every database here is a member of `DEFAULT_POSTCODE_DATABASES` (`gazetteer-pipeline/index.ts`), and the key floors
 * in {@linkcode POSTCODE_BINARY_KEY_FLOORS} were measured against these same files — a country added to one table
 * without a row in the other floors at 1 and refuses only a zero-key build.
 */
export const POSTCODE_BINARY_SOURCES: readonly PostcodeBinarySource[] = [
	{ country: "US", database: "postalcode-us.db" },
	{ country: "NL", database: "postalcode-intl.db" },
	{ country: "FR", database: "postalcode-intl.db" },
	{ country: "DE", database: "postalcode-intl.db" },
	{ country: "ES", database: "postalcode-intl.db" },
	{ country: "IT", database: "postalcode-intl.db" },
	// Code-Point Open (OGL v3.0): the unit set is train-faithful and 20 MB; only the districts fit a browser bundle.
	{ country: "GB", database: "postalcode-gb-codepoint.db", browserGranularity: "outward" },
]

/**
 * The browser granularity registered for a country, or `undefined` when its full key set ships as-is.
 */
export function browserGranularityFor(country: string): GBGranularity | undefined {
	return POSTCODE_BINARY_SOURCES.find((source) => source.country === country.toUpperCase())?.browserGranularity
}

/**
 * A raw database row, as the command's `SELECT name, latitude, longitude` returns it.
 */
export interface PostcodeDatabaseRow {
	name: string
	lat: number
	lon: number
}

export interface BuildPostcodeBinaryOptions {
	/**
	 * GB key granularity. Default `unit` — see {@linkcode GBGranularity}. Ignored for every other country.
	 */
	gbGranularity?: GBGranularity
}

export interface BuildPostcodeBinaryResult {
	entries: PostcodeBinaryEntry[]
	/**
	 * Rows dropped because they do not carry a key of the country's shape (GB only today — a non-unit-shaped `name` would
	 * key a span the inference-side shape detector could never produce).
	 */
	skipped: number
	/**
	 * GB outward districts included in `entries` (0 for every other country).
	 */
	outwardKeys: number
}

/**
 * The key a database `name` enters the binary under. GB is space-stripped to the train painter's form; every other
 * system stores `name` already normalized (DE/FR `68161`, NL `1012LM`, US `94105`), so it serializes verbatim.
 */
export function postcodeBinaryKey(country: string, name: string): string {
	const upper = (name || "").trim().toUpperCase()

	return country.toUpperCase() === "GB" ? upper.replaceAll(" ", "") : upper
}

/**
 * The outward district of a GB unit postcode, derived by SHAPE from either database's storage form (`AB101AB` and `AB10
 * 1AB` both yield `AB10`). `null` when the input is not a GB unit shape — an already-outward code, a numeric system's
 * key, or noise.
 */
export function gbOutwardFromKey(name: string): string | null {
	const key = postcodeBinaryKey("GB", name)

	if (!GB_UNIT_KEY.test(key)) return null

	return key.slice(0, -GB_INWARD_LENGTH)
}

/**
 * True when a centroid is a real placement rather than the `(0, 0)` placeholder the WOF ingest writes for an unplaced
 * record. Outward means are taken over PLACED units only, mirroring `addGBOutwardKeys`.
 */
function isPlaced(lat: number, lon: number): boolean {
	return lat !== 0 || lon !== 0
}

/**
 * Derive one country's PCB1 entry set from its database rows. GB gets the unit/outward treatment described in the
 * module docstring; every other country serializes verbatim.
 */
export function buildPostcodeBinaryEntries(
	country: string,
	rows: readonly PostcodeDatabaseRow[],
	options: BuildPostcodeBinaryOptions = {}
): BuildPostcodeBinaryResult {
	const cc = country.toUpperCase()

	if (cc !== "GB") {
		return {
			entries: rows.map((row) => ({
				postcode: postcodeBinaryKey(cc, row.name),
				country: cc,
				lat: Number(row.lat),
				lon: Number(row.lon),
			})),
			skipped: 0,
			outwardKeys: 0,
		}
	}

	const granularity = options.gbGranularity ?? "unit"
	const entries: PostcodeBinaryEntry[] = []
	const outward = new Map<string, { lat: number; lon: number; n: number }>()
	let skipped = 0

	for (const row of rows) {
		const key = postcodeBinaryKey(cc, row.name)
		const district = gbOutwardFromKey(key)

		if (district === null) {
			skipped++

			continue
		}

		const lat = Number(row.lat)
		const lon = Number(row.lon)

		if (granularity === "unit") {
			entries.push({ postcode: key, country: "GB", lat, lon })
		}

		if (!isPlaced(lat, lon)) continue
		const bucket = outward.get(district)

		if (bucket) {
			bucket.lat += lat
			bucket.lon += lon

			bucket.n++
		} else {
			outward.set(district, { lat, lon, n: 1 })
		}
	}

	for (const [district, { lat, lon, n }] of outward) {
		entries.push({ postcode: district, country: "GB", lat: lat / n, lon: lon / n })
	}

	return { entries, skipped, outwardKeys: outward.size }
}

/**
 * Per-country key floors — the "this build did not silently collapse" gate (#1509).
 *
 * MEASURED 2026-08-06 against the shipped databases, `SELECT COUNT(*) FROM spr WHERE placetype='postalcode' AND
 * is_current!=0 AND country=?`:
 *
 *     US 42,318 (postalcode-us.db)          NL 371,628 (postalcode-intl.db)
 *     FR 27,119 (postalcode-intl.db)        DE  29,694 (postalcode-intl.db)
 *     ES 11,331 (postalcode-intl.db)        IT   4,936 (postalcode-intl.db)
 *     GB 1,746,976 units (postalcode-gb-codepoint.db) → 1,749,839 keys with the 2,863 outward districts
 *
 * Each floor is HALF the measured count, rounded down to a round number. Half, because these floors exist to catch a
 * collapse (a derivation that stopped matching the database's storage form, a country filter that stopped selecting) —
 * not to pin a count that legitimately moves with every upstream refresh. A build that comes back at 51% of what the
 * database holds is still wrong, but it is wrong in a way a human reads in the roll-up; a build at 0% is the one that
 * ships silently.
 *
 * The `GB:outward` row is keyed by granularity because the two GB modes differ by three orders of magnitude — a `unit`
 * build that comes back at outward scale is exactly the regression this table has to name.
 *
 * A country absent from this table floors at 1 (see {@linkcode keyFloorFor}): no measurement to reason from, but zero
 * is always a refusal.
 */
export const POSTCODE_BINARY_KEY_FLOORS: Readonly<Record<string, number>> = {
	US: 20_000,
	NL: 100_000,
	FR: 13_000,
	DE: 14_000,
	ES: 5000,
	IT: 2000,
	GB: 800_000,
	"GB:outward": 1000,
}

/**
 * The floor a `(country, granularity)` build must clear. Unmeasured countries floor at 1 — the meaning-of-zero rule
 * applies to every locale, the calibrated floor only to the ones with a measurement behind it.
 */
export function keyFloorFor(country: string, granularity: GBGranularity): number {
	const cc = country.toUpperCase()
	const keyed = cc === "GB" && granularity === "outward" ? "GB:outward" : cc

	return POSTCODE_BINARY_KEY_FLOORS[keyed] ?? 1
}

/**
 * The reason a build must be REFUSED, or `null` when it clears its floor. Callers exit nonzero on a non-null return —
 * writing the artifact anyway is the #1467 defect class (a fed channel with nothing in it).
 */
export function keyFloorViolation(country: string, keys: number, granularity: GBGranularity): string | null {
	const floor = keyFloorFor(country, granularity)

	if (keys >= floor) return null
	const cc = country.toUpperCase()
	const scope = cc === "GB" ? `${cc} (${granularity} granularity)` : cc

	return (
		`refusing to write the ${scope} postcode binary: the build produced ${keys.toLocaleString()} keys, ` +
		`below the floor of ${floor.toLocaleString()}. An empty or collapsed binary is a build failure, not a ` +
		`product — it feeds the anchor channel nothing while reporting success (#1509/#1467). Check that the ` +
		`database's \`name\` column carries the key shape this country's derivation expects, and that the ` +
		`\`country\` filter selects rows at all.`
	)
}
