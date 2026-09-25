/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tableExists } from "@mailwoman/sqlite"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { DEFAULT_VERIFY_BASELINE } from "#gazetteer-pipeline/verify/baseline"

/**
 * Records the outcome of one named gazetteer verification check.
 */
export interface VerifyCheckResult {
	check: string
	ok: boolean
	detail: string
}

/**
 * Collects the checks of one verification run; `ok` is true only when every check passed.
 */
export interface VerifyResult {
	ok: boolean
	checks: VerifyCheckResult[]
}

/**
 * Describes the committed expectations an admin database must meet: the country
 * and region nodes each country requires, plus row and country floors.
 */
export interface VerifyBaseline {
	/**
	 * Maps each ISO2 country to the placetypes it must have, each needing at least one current `spr` row.
	 */
	requiredNodes: Record<string, ReadonlyArray<"country" | "region">>
	minRows: number
	minCountries: number
}

/**
 * The committed baseline (deliberate updates only — see `verify-baseline.ts`).
 */
export function loadDefaultBaseline(): VerifyBaseline {
	return DEFAULT_VERIFY_BASELINE
}

const EXTENT_SPOT_COUNTRIES = ["BE", "AT", "CH", "LU"] as const

/**
 * Runs the structural checks against an open admin database using SQL alone.
 */
export function verifyAdmin<DB>(db: DatabaseClient<DB>, baseline: VerifyBaseline): VerifyResult {
	const checks: VerifyCheckResult[] = []

	{
		const present = new Set<string>()

		for (const row of db
			.prepare(
				"SELECT country, placetype FROM spr WHERE is_current != 0 AND is_deprecated = 0 GROUP BY country, placetype"
			)
			.all() as Array<{ country: string; placetype: string }>) {
			present.add(`${row.country}/${row.placetype}`)
		}

		const missing: string[] = []

		for (const [cc, placetypes] of Object.entries(baseline.requiredNodes)) {
			for (const pt of placetypes) {
				if (!present.has(`${cc}/${pt}`)) {
					missing.push(`${cc}/${pt}`)
				}
			}
		}

		checks.push({
			check: "node-census",
			ok: missing.length === 0,
			detail: !missing.length
				? `${Object.keys(baseline.requiredNodes).length} countries complete`
				: `missing: ${missing.join(" ")}`,
		})
	}

	{
		const c = db
			.prepare("SELECT COUNT(*) rows, COUNT(DISTINCT country) countries FROM spr WHERE is_current != 0")
			.get() as { rows: number; countries: number }

		const ok = c.rows >= baseline.minRows && c.countries >= baseline.minCountries

		checks.push({
			check: "coverage-floor",
			ok,
			detail: `${c.rows.toLocaleString()} rows / ${c.countries} countries (floor ${baseline.minRows.toLocaleString()} / ${baseline.minCountries})`,
		})
	}

	{
		const abbrCount = (db.prepare("SELECT COUNT(*) n FROM names WHERE language = 'abbr'").get() as { n: number }).n

		const vt = tableExists(db, "place_abbr")
			? (db
					.prepare("SELECT s.name FROM place_abbr a JOIN spr s ON s.id = a.id WHERE a.abbr = 'VT' AND s.country = 'US'")
					.get() as { name: string } | undefined)
			: undefined

		const ok = abbrCount > 0 && vt?.name === "Vermont"

		checks.push({
			check: "region-abbrevs",
			ok,
			detail: ok ? `${abbrCount} abbr names; VT→Vermont` : `abbr names: ${abbrCount}; VT→${vt?.name ?? "(no hit)"}`,
		})
	}

	{
		const rows = tableExists(db, "place_abbr")
			? (db.prepare("SELECT COUNT(*) n FROM place_abbr").get() as { n: number }).n
			: 0

		checks.push({ check: "place-abbr", ok: rows > 0, detail: `${rows} rows` })
	}

	{
		const sprCount = (db.prepare("SELECT COUNT(*) n FROM spr WHERE is_current != 0").get() as { n: number }).n

		const bboxCount = tableExists(db, "place_bbox")
			? (db.prepare("SELECT COUNT(*) n FROM place_bbox").get() as { n: number }).n
			: 0

		const ok = tableExists(db, "place_search") && bboxCount >= sprCount * 0.9

		checks.push({
			check: "fts-bbox",
			ok,
			detail: `place_search=${tableExists(db, "place_search")}, place_bbox ${bboxCount.toLocaleString()} vs spr ${sprCount.toLocaleString()}`,
		})
	}

	{
		const placeholders = EXTENT_SPOT_COUNTRIES.map(() => "?").join(",")

		const extents = db
			.prepare(
				`SELECT country, COUNT(*) total, SUM(CASE WHEN max_latitude - min_latitude > 0.05 THEN 1 ELSE 0 END) real ` +
					`FROM spr WHERE country IN (${placeholders}) AND placetype = 'region' AND is_current != 0 GROUP BY country`
			)
			.all(...EXTENT_SPOT_COUNTRIES) as Array<{ country: string; total: number; real: number | null }>

		const bad = extents.filter((row) => row.total > 0 && (row.real ?? 0) === 0).map((row) => row.country)

		checks.push({
			check: "bbox-extents",
			ok: bad.length === 0,
			detail: !bad.length ? "spot countries carry real region extents" : `degenerate region bboxes: ${bad.join(" ")}`,
		})
	}

	return { ok: checks.every((c) => c.ok), checks }
}

/**
 * Lists the reverse-geocoding panel as `[label, lat, lon, expectedISO2]`,
 * covering EU capitals and cities near national borders.
 */
export const REVERSE_PANEL_CASES: ReadonlyArray<readonly [string, number, number, string]> = [
	["Brussels", 50.8503, 4.3517, "BE"],
	["Amsterdam", 52.3676, 4.9041, "NL"],
	["Paris", 48.8566, 2.3522, "FR"],
	["Berlin", 52.52, 13.405, "DE"],
	["Luxembourg", 49.6116, 6.1319, "LU"],
	["Vienna", 48.2082, 16.3738, "AT"],
	["Bern", 46.948, 7.4474, "CH"],
	["Antwerpen", 51.2194, 4.4025, "BE"],
	["Gent", 51.0543, 3.7174, "BE"],
	["Liège", 50.6326, 5.5797, "BE"],
	["Aachen (DE, ~5km from BE/NL)", 50.7753, 6.0839, "DE"],
	["Maastricht (NL, ~5km from BE)", 50.8514, 5.691, "NL"],
	["Lille (FR, ~15km from BE)", 50.6292, 3.0573, "FR"],
	["Basel (CH, on DE/FR border)", 47.5596, 7.5886, "CH"],
	["Luxembourg City (~15km from FR/DE)", 49.6116, 6.1319, "LU"],
]

/**
 * Reverse-geocodes every panel case against the admin database and checks that
 * each lands in its expected country.
 *
 * The resolver is imported lazily because it is an optional peer.
 */
export async function verifyReversePanel(adminDBPath: PathBuilderLike): Promise<VerifyResult> {
	const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")
	using rg = new WOFReverseGeocoder({ adminDBPath })
	const checks: VerifyCheckResult[] = []

	for (const [label, lat, lon, expected] of REVERSE_PANEL_CASES) {
		const r = await rg.reverseGeocode(lat, lon)
		const deepest = r.hierarchy[0]
		const got = (r.hierarchy.find((h) => h.placetype === "country")?.country ?? deepest?.country ?? "").toUpperCase()

		checks.push({
			check: `reverse:${label}`,
			ok: got === expected,
			detail: `${deepest?.name ?? "(empty)"} → ${got || "(none)"} (want ${expected})`,
		})
	}

	return { ok: checks.every((c) => c.ok), checks }
}

/**
 * Derives a baseline from an existing admin database, for deliberate updates to the committed `baseline.ts`.
 *
 * It requires every country and region node present now and sets the row floor at 98% of the current count.
 */
export function generateBaseline<DB>(db: DatabaseClient<DB>): VerifyBaseline {
	const requiredNodes: Record<string, Array<"country" | "region">> = {}

	for (const r of db
		.prepare(
			"SELECT DISTINCT country, placetype FROM spr WHERE placetype IN ('country','region') AND is_current != 0 AND country != '' ORDER BY country"
		)
		.all() as Array<{ country: string; placetype: "country" | "region" }>) {
		;(requiredNodes[r.country] ??= []).push(r.placetype)
	}

	const c = db
		.prepare("SELECT COUNT(*) rows, COUNT(DISTINCT country) countries FROM spr WHERE is_current != 0")
		.get() as { rows: number; countries: number }

	return {
		requiredNodes,

		minRows: Math.floor(c.rows * 0.98),
		minCountries: c.countries,
	}
}
