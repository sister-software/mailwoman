/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The MEASURED COVERAGE RECORD for the candidate gazetteer + its build-time emission (survey
 *   candidate #2, 2026-07-26) — the durable home for two sets of facts that used to be hand-grown
 *   code constants updated by PR-after-someone-remembers:
 *
 *   - The hard-country-filter coverage measurements (#743/#194) behind
 *     `HARD_PLACE_COUNTRY_SAFELIST` (`core/pipeline/runtime-pipeline.ts`) — previously a code
 *     comment ("US 100, FR 100 … FI 69.5 (out)"), i.e. measurement as trivia.
 *   - The guard-B plausibility boxes behind `COUNTRY_BBOX` (`resolver/plausibility.ts`).
 *
 *   Doctrine (operator-ratified 2026-07-26): facts ABOUT an artifact live in the artifact's
 *   manifest, read at load — so they update at gazetteer REBUILD, not at a code PR. This module is
 *   the drawer: it owns the reviewed measurement record ({@link MEASURED_COUNTRY_COVERAGE},
 *   {@link MEASURED_COUNTRY_BBOXES} — grow THESE at promotes, like `defaults.ts` owns the build
 *   recipe) and the emission step `buildCandidate` runs before sealing. The schema + canonical
 *   read/write functions live in `@mailwoman/resolver-wof-sqlite/coverage-manifest-schema` (the
 *   fold/build convention: canonical package functions, composed here).
 *
 *   The SHIPPED candidate gazetteer is never patched ("never patch databases — rebuild"): an
 *   artifact predating the manifest reads `undefined` at open and every consumer falls back to the
 *   code constants byte-identically. The meaning-of-zero rule is honored structurally: FI/PL are
 *   PRESENT rows with `hardFilterSafe: false` (measured, failed the gate) — distinguishable from a
 *   country that was simply never measured (absent row).
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import type { CountryBBoxFact, CountryCoverageFact } from "@mailwoman/core/resolver"
// resolver-wof-sqlite is an optional peer of mailwoman (the geocode.tsx convention) — runtime
// imports are DYNAMIC inside the functions; type-only imports are erased and safe at module level.
import type { GazetteerCoverageDatabase } from "@mailwoman/resolver-wof-sqlite"

/**
 * Shared source string for the #743 promote measurements.
 */
const OA_PANEL_SOURCE = "#743 OA held-out hard-resolve panel (DeepSeek-advised gate, 2026-06-22)"

/**
 * Shared source string for the #928 promote OSM panels.
 */
const OSM_PANEL_SOURCE = "#928 promote OSM panel, night 34 (2026-07-06)"

/**
 * The reviewed per-country hard-filter coverage record — every promote-gate verdict + measurement that grew (or
 * deliberately kept a country off) the hard-country safelist. This is the structured form of the receipts that lived in
 * the `HARD_PLACE_COUNTRY_SAFELIST` code comment; the derived safelist (`hardFilterSafe === true`) is asserted
 * byte-identical to that constant in `coverage-manifest.test.ts`, so the two cannot drift silently.
 *
 * Grow THIS at promotes (with the panel receipt in `source`); the fact reaches production at the next gazetteer rebuild
 * — the constant in core is only the fallback for artifacts predating the manifest.
 */
export const MEASURED_COUNTRY_COVERAGE: readonly CountryCoverageFact[] = [
	{ country: "US", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "FR", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "DE", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "ES", hardFilterSafe: true, hardResolveRate: 0.998, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "NL", hardFilterSafe: true, hardResolveRate: 0.973, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "IT", hardFilterSafe: true, hardResolveRate: 0.968, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// Measured and FAILED the gate — present rows on purpose (meaning-of-zero: a failed measurement is a
	// first-class negative result, distinguishable from "never measured"). They stay on the soft prior
	// until their gazetteer coverage is filled (#193).
	{ country: "FI", hardFilterSafe: false, hardResolveRate: 0.695, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "PL", hardFilterSafe: false, hardResolveRate: 0.778, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// #928 promote (2026-07-06): the postcodeCountryPrior FORMAT signal routes GB/CA confidently (the
	// language placer conflated both with US), and the OSM-panel gates passed with the hard filter ON.
	// Rates here are the panels' RESOLVE rates (1 − unresolved/n): GB 293/300 (271 ok, 7 unresolved),
	// CA 269/300 (200 ok, 31 unresolved) — CA cleared on the format-prior rationale despite the sub-95%
	// panel number, which is exactly why `hardFilterSafe` is a stored VERDICT, not a rate threshold.
	{
		country: "GB",
		hardFilterSafe: true,
		hardResolveRate: 0.977,
		sampleSize: 300,
		measuredAt: "2026-07-06",
		source: OSM_PANEL_SOURCE,
	},
	{
		country: "CA",
		hardFilterSafe: true,
		hardResolveRate: 0.897,
		sampleSize: 300,
		measuredAt: "2026-07-06",
		source: OSM_PANEL_SOURCE,
	},
	// AU added with the #244 AU placer class: 150k-row G-NAF training → AU test-acc 100%, and the hard
	// filter is recall-SAFE on the AU panel (unresolved 4→2 while abroad 43→20). No single-rate number
	// in the receipt → no `hardResolveRate` (never invent a magnitude).
	{
		country: "AU",
		hardFilterSafe: true,
		measuredAt: "2026-07-06",
		source: "#244 AU placer-class promote (2026-07-06): hard filter recall-safe (unresolved 4→2, abroad 43→20)",
	},
]

/**
 * Shared source string for the guard-B boxes.
 */
const BBOX_SOURCE = "2026-07-15 coordinate-parity receipt harness (scratchpad/coord-parity.mjs) — deliberately coarse"

const bbox = (country: string, latMin: number, latMax: number, lonMin: number, lonMax: number): CountryBBoxFact => ({
	country,
	latMin,
	latMax,
	lonMin,
	lonMax,
	source: BBOX_SOURCE,
})

/**
 * The reviewed guard-B bounding-box record — the structured form of `COUNTRY_BBOX` (`resolver/plausibility.ts`),
 * asserted byte-identical to that constant in `coverage-manifest.test.ts`. Same growth discipline as
 * {@link MEASURED_COUNTRY_COVERAGE}: add boxes HERE; the constant is only the pre-manifest fallback.
 */
export const MEASURED_COUNTRY_BBOXES: readonly CountryBBoxFact[] = [
	bbox("US", 18, 72, -180, -66),
	bbox("AU", -44, -10, 112, 154),
	bbox("BR", -34, 6, -74, -34),
	bbox("CZ", 48, 51.5, 12, 19),
	bbox("DE", 47, 55.5, 5.5, 15.5),
	bbox("ES", 35, 44, -10, 5),
	bbox("FR", 41, 51.5, -5.5, 9.8),
	bbox("GB", 49, 61, -8.7, 2),
	bbox("HR", 42, 46.6, 13, 19.5),
	bbox("IN", 6, 36, 68, 98),
	bbox("NL", 50.7, 53.7, 3.3, 7.3),
	bbox("NO", 57, 71.5, 4, 31),
	bbox("PL", 49, 55, 14, 24.2),
	bbox("PT", 36.5, 42.2, -9.6, -6.1),
	bbox("RO", 43.5, 48.3, 20, 30),
	bbox("SE", 55, 69.1, 10.9, 24.2),
	bbox("SK", 47.7, 49.7, 16.8, 22.6),
	bbox("SI", 45.4, 46.9, 13.3, 16.6),
]

export interface EmitCoverageManifestOptions {
	/**
	 * The candidate DB under construction — MUST be pre-seal (a shipped DB is never patched, rebuild instead).
	 */
	dbPath: string
	/**
	 * Coverage rows to bake (default {@link MEASURED_COUNTRY_COVERAGE}).
	 */
	coverage?: readonly CountryCoverageFact[]
	/**
	 * Guard-B bbox rows to bake (default {@link MEASURED_COUNTRY_BBOXES}).
	 */
	bboxes?: readonly CountryBBoxFact[]
}

/**
 * Bake the coverage manifest into a candidate DB under construction. Called by `buildCandidate` between the candidate
 * build and the seal; standalone use is fine for tests/fixtures (never against a sealed artifact).
 */
export async function emitCoverageManifest(opts: EmitCoverageManifestOptions): Promise<void> {
	const { writeGazetteerCoverageManifest } = await import("@mailwoman/resolver-wof-sqlite")

	const db = new DatabaseSync(opts.dbPath)
	const kdb = new DatabaseClient<GazetteerCoverageDatabase>({ database: db })

	try {
		await writeGazetteerCoverageManifest(kdb, {
			coverage: opts.coverage ?? MEASURED_COUNTRY_COVERAGE,
			bboxes: opts.bboxes ?? MEASURED_COUNTRY_BBOXES,
		})
	} finally {
		// `kdb` wraps the same handle; destroy() owns the close.
		await kdb.destroy()
	}
}
