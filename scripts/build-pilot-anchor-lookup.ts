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
 *       `docs/articles/evals/2026-06-05-postcode-posterior-ab.md`). A German PLZ that collides with
 *       a US ZIP (e.g. 10115) comes back `{"DE": 0.5, "US": 0.5}`.
 *   - **centroid**: taken from the first source that has a real centroid, in DE→FR→US order, so the
 *       collapse-relevant European rows get a European centroid on a collision. The centroid is the
 *       secondary signal (the posterior + the categorical anchor cue do the work).
 *   - **source** (#525, the provenance-first rule): names the dataset the centroid came from — `wof`
 *       (our WOF postcode shards, which may carry provenanced backfills; see the `centroid_source`
 *       table), `census-zcta-2024` (Census ZCTA Gazetteer fill, either already in the DB or joined
 *       here via `--zcta`), or `null` for a placeholder (membership only).
 *
 *   Sources (build-from-source, never prebuilt): postalcode-intl.db (DE/FR, inline centroids) +
 *   postalcode-us.db (US; spr centroids are real post-backfill).
 *
 *   ZCTA caveat: ZCTAs approximate delivery areas, not ZIPs — PO-box-only/unique ZIPs have no ZCTA
 *   and stay placeholder. Vintage + URL: $MAILWOMAN_DATA_ROOT/census/README.md.
 *
 *   Usage: node --experimental-strip-types scripts/build-pilot-anchor-lookup.ts\
 *   --zcta $MAILWOMAN_DATA_ROOT/census/2024_Gaz_zcta_national.txt\
 *   --output $MAILWOMAN_DATA_ROOT/anchor/pilot-anchor-lookup.json
 *
 *   PORT NOTE (from scripts/build-pilot-anchor-lookup.py): faithful TypeScript port. The output is a
 *   JSON file written DIRECTLY to `--output` (no DB, no temp-then-move; matches the Python). The
 *   serializer reproduces Python's `json.dumps(..., ensure_ascii=False)` formatting (", " / ": "
 *   separators, integer-valued floats rendered with a trailing `.0`) so the emitted file matches
 *   the original. The WOF data root is resolved through `dataRootPath` (the one home for the
 *   `/mnt/playpen` default) instead of the Python's hardcoded literal — identical default path, now
 *   also `$MAILWOMAN_DATA_ROOT` overridable.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"

const ZCTA_SOURCE = "census-zcta-2024" // keep in sync with scripts/zcta-centroids.ts

/** (lat, lon, source): source is null when the row is a placeholder (membership only). */
type Centroid = [number, number, string | null]

/** Increment a non-negative decimal-digit string, propagating the carry (e.g. "999" → "1000"). */
function incDecimalString(s: string): string {
	const a = s.split("")
	let i = a.length - 1

	for (; i >= 0; i--) {
		if (a[i] === "9") a[i] = "0"
		else {
			a[i] = String(Number(a[i]) + 1)
			break
		}
	}

	if (i < 0) a.unshift("1")

	return a.join("")
}

/**
 * Python `round()` — correctly-rounded, round-half-to-EVEN. Works off the double's EXACT (terminating) decimal
 * expansion via `toFixed(80)`, so it matches Python both on ordinary values (where a naïve `x * 10**nd` would diverge
 * by a ULP) and on exact half-way ties like `40.890625` → `40.89062` (where `toFixed(nd)` rounds half-UP and would
 * diverge). `nd === 0` keeps a fast half-even path on the double.
 */
function pyRound(x: number, nd: number = 0): number {
	if (!Number.isFinite(x)) return x

	if (nd === 0) {
		const floor = Math.floor(x)
		const diff = x - floor

		if (diff < 0.5) return floor

		if (diff > 0.5) return floor + 1

		return floor % 2 === 0 ? floor : floor + 1
	}
	const neg = x < 0
	const digits = Math.abs(x).toFixed(20) // exact expansion for any coord/distance-range double
	const dot = digits.indexOf(".")
	const intPart = digits.slice(0, dot)
	const frac = digits.slice(dot + 1)
	const keep = frac.slice(0, nd)
	const rest = frac.slice(nd)
	let roundUp = false
	const first = rest.charCodeAt(0) - 48

	if (first > 5) roundUp = true
	else if (first === 5) {
		if (/[1-9]/.test(rest.slice(1))) roundUp = true
		else {
			// exact half → round to even
			const lastKept = keep.length ? keep.charCodeAt(keep.length - 1) - 48 : Number(intPart) % 10
			roundUp = lastKept % 2 === 1
		}
	}
	let combined = intPart + keep

	if (roundUp) combined = incDecimalString(combined)
	const num = Number(combined) / 10 ** nd

	return neg ? -num : num
}

/** Python `float()`: trimmed empty / non-numeric → null (the load_zcta try/except skip). */
function pyFloat(s: string | undefined): number | null {
	if (s === undefined) return null
	const t = s.trim()

	if (t === "") return null
	const n = Number(t)

	return Number.isNaN(n) ? null : n
}

function fiveDigit(name: string | null | undefined): string | null {
	const n = (name || "").trim().toUpperCase()

	return /^[0-9]{5}$/.test(n) ? n : null
}

function placed(lat: number, lon: number): boolean {
	return lat !== 0.0 || lon !== 0.0
}

/** DE/FR postcodes → centroid from postalcode-intl.db (inline lat/lon). */
function loadIntl(country: string): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	const con = new DatabaseSync(dataRootPath("wof", "postalcode-intl.db"))
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
	con.close()

	return out
}

/**
 * US postcodes → spr centroid, with per-row provenance from `centroid_source` when present (rows the ZCTA fill placed
 * carry `census-zcta-2024`; untracked placed rows are `wof`).
 */
function loadUs(): Map<string, Centroid> {
	const out = new Map<string, Centroid>()
	const con = new DatabaseSync(dataRootPath("wof", "postalcode-us.db"))
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
	con.close()

	return out
}

/**
 * Census ZCTA Gazetteer file → 5-digit code → internal-point centroid (mirror of
 * scripts/zcta-centroids.ts::parseZctaCentroids).
 */
function loadZcta(path: string): Map<string, [number, number]> {
	const out = new Map<string, [number, number]>()

	for (const line of readFileSync(path, "utf8").split("\n")) {
		const fields = line.split("\t").map((f) => f.trim())
		const pc = fields.length ? fiveDigit(fields[0]) : null

		if (!pc || fields.length < 7) continue
		const lat = pyFloat(fields[5])
		const lon = pyFloat(fields[6])

		if (lat === null || lon === null) continue

		if (placed(lat, lon)) out.set(pc, [lat, lon])
	}

	return out
}

/** Python `ensure_ascii=False` JSON string escape (quote, backslash, control chars). */
function pyJsonStr(s: string): string {
	let out = '"'

	for (const ch of s) {
		const code = ch.codePointAt(0)!

		if (ch === '"') out += '\\"'
		else if (ch === "\\") out += "\\\\"
		else if (ch === "\n") out += "\\n"
		else if (ch === "\r") out += "\\r"
		else if (ch === "\t") out += "\\t"
		else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0")
		else out += ch
	}

	return out + '"'
}

/** Python `repr`/`json` of a float — shortest round-trip, but integer-valued renders with `.0`. */
function pyJsonNum(x: number): string {
	if (Number.isInteger(x)) return Object.is(x, -0) ? "-0.0" : `${x}.0`

	return String(x)
}

/** Serialize one lookup value `[posterior, lat, lon, source]` the way Python `json.dumps` would. */
function pyJsonValue(v: unknown): string {
	if (v === null) return "null"

	if (typeof v === "number") return pyJsonNum(v)

	if (typeof v === "string") return pyJsonStr(v)

	if (Array.isArray(v)) return "[" + v.map(pyJsonValue).join(", ") + "]"
	const parts: string[] = []

	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		parts.push(pyJsonStr(k) + ": " + pyJsonValue(val))
	}

	return "{" + parts.join(", ") + "}"
}

type LookupRow = [Record<string, number>, number, number, string | null]

interface Args {
	output: string
	zcta?: string
}

function parseCliArgs(): Args {
	const { values } = parseArgs({
		options: {
			output: { type: "string" },
			zcta: { type: "string" },
		},
	})

	if (!values.output) {
		console.error(
			"Usage: build-pilot-anchor-lookup.ts --output <pilot-anchor-lookup.json> [--zcta <2024_Gaz_zcta.txt>]"
		)
		process.exit(2)
	}

	return { output: values.output, zcta: values.zcta }
}

function main(): void {
	const args = parseCliArgs()

	const sources: Array<[string, Map<string, Centroid>]> = [
		["DE", loadIntl("DE")],
		["FR", loadIntl("FR")],
		["US", loadUs()],
	] // centroid priority order
	const zcta = args.zcta ? loadZcta(args.zcta) : new Map<string, [number, number]>()
	const allCodes = new Set<string>()

	for (const [, d] of sources) for (const k of d.keys()) allCodes.add(k)

	const lookup: Record<string, LookupRow> = {}
	const sortedCodes = [...allCodes].sort()
	let collisions = 0
	let zctaFilled = 0

	for (const pc of sortedCodes) {
		const members = sources.filter(([, d]) => d.has(pc)).map(([c]) => c)
		const k = members.length
		const posterior: Record<string, number> = {}

		for (const c of members) posterior[c] = 1.0 / k

		if (k > 1) collisions++
		// centroid: first source (DE→FR→US) with a non-zero centroid; never overwritten by ZCTA.
		let lat = 0.0
		let lon = 0.0
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
		lookup[pc] = [posterior, pyRound(lat, 5), pyRound(lon, 5), source]
	}

	// Serialize the top level from the SORTED key array, not `Object.entries(lookup)`: JS hoists
	// integer-like string keys (e.g. "10000") ahead of insertion order, which would unsort the output.
	const body = sortedCodes.map((pc) => pyJsonStr(pc) + ": " + pyJsonValue(lookup[pc]!)).join(", ")
	writeFileSync(args.output, "{" + body + "}", "utf8")

	const byCountry: Record<string, number> = {}

	for (const [c] of sources) byCountry[c] = Object.values(lookup).filter((v) => c in v[0]).length
	const bySource = new Map<string | null, number>()

	for (const v of Object.values(lookup)) bySource.set(v[3], (bySource.get(v[3]) ?? 0) + 1)
	const placeholders = bySource.get(null) ?? 0

	// Python repr of `{k or 'placeholder': n for k, n in sorted(by_source.items(), key=lambda kv: -kv[1])}`.
	const sourceRepr =
		"{" +
		[...bySource.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `'${k ?? "placeholder"}': ${n}`)
			.join(", ") +
		"}"
	const total = Object.keys(lookup).length
	console.log(
		`${total.toLocaleString("en-US")} postcodes → ${args.output}  ` +
			`(DE ${byCountry["DE"]!.toLocaleString("en-US")}, FR ${byCountry["FR"]!.toLocaleString("en-US")}, ` +
			`US ${byCountry["US"]!.toLocaleString("en-US")}; ${collisions.toLocaleString("en-US")} collisions; ` +
			`${zctaFilled.toLocaleString("en-US")} ZCTA-filled here; sources ${sourceRepr}; ` +
			`${placeholders.toLocaleString("en-US")} no-centroid = ${((100 * placeholders) / total).toFixed(1)}%)`
	)
}

// Run main() only when invoked directly (the import-safe equivalent of Python's `if __name__ ==
// "__main__"`), so importing this module evaluates it without running the build.
const selfPath = realpathSync(fileURLToPath(import.meta.url))
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : ""

if (entryPath && entryPath === selfPath) {
	main()
}
