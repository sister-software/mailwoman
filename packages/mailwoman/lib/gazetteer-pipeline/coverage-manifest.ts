/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The measured coverage record for the candidate gazetteer + its build-time emission (survey
 *   candidate #2, 2026-07-26) — the durable home for two sets of facts that used to be hand-grown
 *   code constants updated by PR-after-someone-remembers:
 *
 *   - The hard-country-filter coverage measurements (#743/#194) behind
 *     `HARD_PLACE_COUNTRY_SAFELIST` (`core/pipeline/runtime-pipeline.ts`) — previously a code
 *     comment ("US 100, FR 100 … FI 69.5 (out)"), i.e. measurement as trivia.
 *   - The guard-B plausibility boxes behind `COUNTRY_BBOX` (`resolver/plausibility.ts`).
 *
 *   Doctrine (operator-ratified 2026-07-26): facts about an artifact live in the artifact's
 *   manifest, read at load — so they update at gazetteer rebuild rather than at a code PR. This module is
 *   the drawer: it owns the reviewed measurement record ({@link MEASURED_COUNTRY_COVERAGE},
 *   {@link MEASURED_COUNTRY_BBOXES} — grow these at promotes, like `defaults.ts` owns the build
 *   recipe) and the emission step `buildCandidate` runs before sealing. The schema + canonical
 *   read/write functions live in `@mailwoman/resolver-wof-sqlite/coverage-manifest-schema` (the
 *   fold/build convention: canonical package functions, composed here).
 *
 *   The shipped candidate gazetteer is never patched ("never patch databases — rebuild"): an
 *   artifact predating the manifest reads `undefined` at open and every consumer falls back to the
 *   code constants byte-identically. The meaning-of-zero rule is honored structurally: FI/PL are
 *   present rows with `hardFilterSafe: false` (measured, failed the check) — distinguishable from a
 *   country that was simply never measured (absent row).
 */

import type { CountryBBoxFact, CountryCoverageFact } from "@mailwoman/core/resolver"
// resolver-wof-sqlite is an optional peer of mailwoman (the geocode.tsx convention) —
// runtime imports are dynamic inside the functions.
// Type-only imports are erased and safe at module level.
import type { GazetteerCoverageDatabase } from "@mailwoman/resolver-wof-sqlite/coverage-manifest-schema"
import { COUNTRY_BBOX } from "@mailwoman/resolver/plausibility"
import { DatabaseClient } from "@mailwoman/sqlite/client"

/**
 * Shared source string for the #743 promote measurements.
 */
const OA_PANEL_SOURCE = "#743 OA held-out hard-resolve panel (DeepSeek-advised check, 2026-06-22)"

/**
 * Shared source string for the #928 promote OSM panels.
 */
const OSM_PANEL_SOURCE = "#928 promote OSM panel, night 34 (2026-07-06)"

/**
 * The reviewed per-country hard-filter coverage record — every promote-eval verdict +
 * measurement that grew (or deliberately kept a country off) the hard-country safelist.
 *
 * This is the structured form of the receipts that lived in the `HARD_PLACE_COUNTRY_SAFELIST` code comment.
 * The derived safelist (`hardFilterSafe === true`) is asserted byte-identical to that
 * constant in `coverage-manifest.test.ts`, so the two cannot drift silently.
 *
 * Grow this at promotes (with the panel receipt in `source`); the fact reaches
 * production at the next gazetteer rebuild.
 * The constant in core is only the fallback for artifacts predating the manifest.
 */
export const MEASURED_COUNTRY_COVERAGE: readonly CountryCoverageFact[] = [
	{ country: "US", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "FR", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "DE", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "ES", hardFilterSafe: true, hardResolveRate: 0.998, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "NL", hardFilterSafe: true, hardResolveRate: 0.973, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "IT", hardFilterSafe: true, hardResolveRate: 0.968, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// Measured and failed the check — present rows on purpose (meaning-of-zero: a failed measurement is a first-class negative result, distinguishable from "never measured"). They stay on the soft prior until their gazetteer coverage is filled (#193).
	{ country: "FI", hardFilterSafe: false, hardResolveRate: 0.695, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "PL", hardFilterSafe: false, hardResolveRate: 0.778, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// #928 promote (2026-07-06): the postcodeCountryPrior format signal routes GB/CA confidently (the language placer conflated both with US), and the OSM-panel checks passed with the hard filter on. Rates here are the panels' resolve rates (1 − unresolved/n): GB 293/300 (271 ok, 7 unresolved), CA 269/300 (200 ok, 31 unresolved). CA cleared on the format-prior rationale despite the sub-95% panel number, which is exactly why `hardFilterSafe` is a stored verdict rather than a rate threshold.
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
	// AU added with the #244 AU placer class: 150k-row G-NAF training → AU test-acc 100%, and the hard filter is recall-safe on the AU panel (unresolved 4→2 while abroad 43→20). No single-rate number in the receipt → no `hardResolveRate` (never invent a magnitude).
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

/**
 * The reviewed guard-B bounding-box record — the structured form of `COUNTRY_BBOX`
 * (`resolver/plausibility.ts`), derived from that constant rather than declared beside it.
 *
 * The two were separate literals with a test asserting them equal.
 * That test compared the numbers and not the membership, and both tables were
 * missing the same four shipping locales.
 *
 * Membership is checked in `plausibility.test.ts` against `release.config.json` instead.
 *
 * `source` is stamped here: provenance belongs to the artifact record rather than to the fallback constant.
 */
export const MEASURED_COUNTRY_BBOXES: readonly CountryBBoxFact[] = Object.entries(COUNTRY_BBOX).map(
	([country, [latMin, latMax, lonMin, lonMax]]): CountryBBoxFact => ({
		country,
		latMin,
		latMax,
		lonMin,
		lonMax,
		source: BBOX_SOURCE,
	})
)

export interface EmitCoverageManifestOptions {
	/**
	 * The candidate DB under construction — must be pre-seal (a shipped DB is never patched, rebuild instead).
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
 * Bake the coverage manifest into a candidate DB under construction.
 *
 * Called by `buildCandidate` between the candidate build and the seal.
 * Standalone use is fine for tests/fixtures (never against a sealed artifact).
 */
export async function emitCoverageManifest(opts: EmitCoverageManifestOptions): Promise<void> {
	const { writeGazetteerCoverageManifest } = await import("@mailwoman/resolver-wof-sqlite")

	const kdb = new DatabaseClient<GazetteerCoverageDatabase>(opts.dbPath)

	try {
		await writeGazetteerCoverageManifest(kdb, {
			coverage: opts.coverage ?? MEASURED_COUNTRY_COVERAGE,
			bboxes: opts.bboxes ?? MEASURED_COUNTRY_BBOXES,
		})
	} finally {
		// `kdb` wraps the same handle. destroy() owns the close.
		await kdb.destroy()
	}
}
