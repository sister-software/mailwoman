/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The structural verify gate for admin-gazetteer builds — run BEFORE sealing/promoting, refuse the
 *   swap on any failure. Row/count gates alone are provably insufficient: the 2026-07-07 #1015 rebuild
 *   passed a rows+countries gate while ~95 countries lost their country/region NODES (#1023/#1026 —
 *   Tbilisi orphaned, "City, Country" scoping broken). Each check here catches a failure class we
 *   actually shipped once:
 *
 *   - `node-census` (#1026): per-country required placetypes vs the committed baseline.
 *   - `coverage-floor`: gross truncation.
 *   - `region-abbrevs` + `place-abbr` (#440 / the #1015 missed post-build steps): VT→Vermont resolves.
 *   - `fts-bbox`: place_search + place_bbox exist and cover spr (a build that skipped the FTS step).
 *   - `bbox-extents` (#1015): Overture-backfilled regions carry REAL extents, not label points.
 *
 *   The reverse panel (`verifyReversePanel`) is the end-to-end leg: EU capitals + border cities must
 *   land in the right country — border towns are the hard class by construction.
 */

import type { DatabaseSync } from "node:sqlite"

import { DEFAULT_VERIFY_BASELINE } from "./verify-baseline.js"

export interface VerifyCheckResult {
	check: string
	ok: boolean
	detail: string
}

export interface VerifyResult {
	ok: boolean
	checks: VerifyCheckResult[]
}

export interface VerifyBaseline {
	/** ISO2 → required node placetypes. A listed country MUST have ≥1 current spr row of each placetype. */
	requiredNodes: Record<string, ReadonlyArray<"country" | "region">>
	minRows: number
	minCountries: number
}

/** The committed baseline (deliberate updates only — see `verify-baseline.ts`). */
export function loadDefaultBaseline(): VerifyBaseline {
	return DEFAULT_VERIFY_BASELINE
}

/** The #1015 Overture-extent spot-check set — checked only when the country has region rows at all. */
const EXTENT_SPOT_COUNTRIES = ["BE", "AT", "CH", "LU"] as const

/** Run the structural checks against an (open) admin DB. Pure SQL — no network, no model. */
export function verifyAdmin(db: DatabaseSync, baseline: VerifyBaseline): VerifyResult {
	const checks: VerifyCheckResult[] = []
	const tableExists = (name: string): boolean =>
		db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined

	// 1. node-census (#1026): every required (country, placetype) node exists.
	{
		const probe = db.prepare(
			"SELECT COUNT(*) n FROM spr WHERE country = ? AND placetype = ? AND is_current != 0 AND is_deprecated = 0"
		)
		const missing: string[] = []

		for (const [cc, placetypes] of Object.entries(baseline.requiredNodes)) {
			for (const pt of placetypes) {
				if ((probe.get(cc, pt) as { n: number }).n === 0) missing.push(`${cc}/${pt}`)
			}
		}
		checks.push({
			check: "node-census",
			ok: missing.length === 0,
			detail:
				missing.length === 0
					? `${Object.keys(baseline.requiredNodes).length} countries complete`
					: `missing: ${missing.join(" ")}`,
		})
	}

	// 2. coverage-floor: gross truncation guard.
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

	// 3. region-abbrevs: the #440 class — abbr names present AND the VT→Vermont join resolves.
	{
		const abbrCount = (db.prepare("SELECT COUNT(*) n FROM names WHERE language = 'abbr'").get() as { n: number }).n
		const vt = tableExists("place_abbr")
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

	// 4. place-abbr: the join table itself (missed entirely in the first #1015 swap).
	{
		const rows = tableExists("place_abbr")
			? (db.prepare("SELECT COUNT(*) n FROM place_abbr").get() as { n: number }).n
			: 0
		checks.push({ check: "place-abbr", ok: rows > 0, detail: `${rows} rows` })
	}

	// 5. fts-bbox: place_search + place_bbox exist and the R*Tree covers spr (≥90% of current rows).
	{
		const sprCount = (db.prepare("SELECT COUNT(*) n FROM spr WHERE is_current != 0").get() as { n: number }).n
		const bboxCount = tableExists("place_bbox")
			? (db.prepare("SELECT COUNT(*) n FROM place_bbox").get() as { n: number }).n
			: 0
		const ok = tableExists("place_search") && bboxCount >= sprCount * 0.9
		checks.push({
			check: "fts-bbox",
			ok,
			detail: `place_search=${tableExists("place_search")}, place_bbox ${bboxCount.toLocaleString()} vs spr ${sprCount.toLocaleString()}`,
		})
	}

	// 6. bbox-extents (#1015): spot countries with region rows must have at least one REAL extent
	//    (dLat > 0.05°) — a degenerate label-point bbox is invisible to reverse bbox-containment.
	{
		const bad: string[] = []

		for (const cc of EXTENT_SPOT_COUNTRIES) {
			const c = db
				.prepare(
					"SELECT COUNT(*) total, SUM(CASE WHEN max_latitude - min_latitude > 0.05 THEN 1 ELSE 0 END) real FROM spr WHERE country = ? AND placetype = 'region' AND is_current != 0"
				)
				.get(cc) as { total: number; real: number | null }

			if (c.total > 0 && (c.real ?? 0) === 0) bad.push(cc)
		}
		checks.push({
			check: "bbox-extents",
			ok: bad.length === 0,
			detail:
				bad.length === 0 ? "spot countries carry real region extents" : `degenerate region bboxes: ${bad.join(" ")}`,
		})
	}

	return { ok: checks.every((c) => c.ok), checks }
}

/**
 * `[label, lat, lon, expectedISO2]` — EU capitals (no regression) + border cities (the adversarial class) + the
 * reported #1015 Belgian failures. Absorbed from `scripts/reverse-eu-panel.ts`.
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
 * The end-to-end reverse leg: every panel case must land in the expected country. Opens the DB read-only; lazy-imports
 * the resolver (an optional peer).
 */
export async function verifyReversePanel(adminDBPath: string): Promise<VerifyResult> {
	const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")
	const rg = new WOFReverseGeocoder({ adminDBPath })
	const checks: VerifyCheckResult[] = []

	try {
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
	} finally {
		rg.close()
	}

	return { ok: checks.every((c) => c.ok), checks }
}

/**
 * Generate a baseline from an existing DB — the DELIBERATE-update path (review the diff of `verify-baseline.ts` like
 * code). Requires `country` for every country that has one; adds `region` where regions exist.
 */
export function generateBaseline(db: DatabaseSync): VerifyBaseline {
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
		// 2% slack under the observed values — the floor catches truncation, not churn.
		minRows: Math.floor(c.rows * 0.98),
		minCountries: c.countries,
	}
}
