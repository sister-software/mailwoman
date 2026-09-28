/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The measured coverage record for the candidate gazetteer and its build-time emission. It is the
 *   durable home for two sets of facts:
 *
 *   - The hard-country-filter coverage measurements behind
 *     `HARD_PLACE_COUNTRY_SAFELIST` (`core/pipeline/runtime-pipeline.ts`).
 *   - The guard-B plausibility boxes behind `COUNTRY_BBOX` (`resolver/plausibility.ts`).
 *
 *   Facts about an artifact live in the artifact's manifest, read at load, so they update at
 *   gazetteer rebuild rather than at a code pull request. This module owns the reviewed measurement
 *   record ({@link MEASURED_COUNTRY_COVERAGE}, {@link MEASURED_COUNTRY_BBOXES}, grown at promotes,
 *   like `defaults.ts` owns the build recipe) and the emission step `buildCandidate` runs before
 *   sealing. The schema and canonical read/write functions live in
 *   `@mailwoman/resolver-wof-sqlite/coverage-manifest-schema` (the fold/build convention: canonical
 *   package functions, composed here).
 *
 *   The shipped candidate gazetteer is never patched ("never patch databases, rebuild"): an
 *   artifact predating the manifest reads `undefined` at open. Every consumer then falls back to the
 *   code constants byte-identically. FI and PL are present rows with `hardFilterSafe: false`.
 *   This setting
 *   keeps a measured failure distinguishable from a country that was never measured (absent row).
 */

import type { CountryBBoxFact, CountryCoverageFact } from "@mailwoman/core/resolver"
// resolver-wof-sqlite's runtime modules are imported inside the functions,
// so loading this module does not evaluate them.
// Type-only imports are erased.
import type { GazetteerCoverageDatabase } from "@mailwoman/resolver-wof-sqlite/coverage-manifest-schema"
import { COUNTRY_BBOX } from "@mailwoman/resolver/plausibility"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

const OA_PANEL_SOURCE = "#743 OA held-out hard-resolve panel (DeepSeek-advised check, 2026-06-22)"

const OSM_PANEL_SOURCE = "#928 promote OSM panel, night 34 (2026-07-06)"

/**
 * The reviewed per-country hard-filter coverage record.
 *
 * Every promote-eval verdict and measurement that grew the hard-country safelist appears here.
 * A country deliberately kept off the list appears with `hardFilterSafe: false`.
 *
 * The derived safelist (`hardFilterSafe === true`) is asserted byte-identical to
 * `HARD_PLACE_COUNTRY_SAFELIST` in `coverage-manifest.test.ts`, so the two cannot drift silently.
 *
 * Grow this at promotes, with the panel receipt in `source`.
 * The fact reaches production at the next gazetteer rebuild.
 *
 * The constant in core is only the fallback for artifacts predating the manifest.
 */
export const MEASURED_COUNTRY_COVERAGE: readonly CountryCoverageFact[] = [
	{ country: "US", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "FR", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "DE", hardFilterSafe: true, hardResolveRate: 1, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "ES", hardFilterSafe: true, hardResolveRate: 0.998, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "NL", hardFilterSafe: true, hardResolveRate: 0.973, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "IT", hardFilterSafe: true, hardResolveRate: 0.968, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// Measured and failed the check.
	// Present rows on purpose: a failed measurement is a first-class negative result,
	// distinguishable from "never measured".
	// They stay on the soft prior until their gazetteer coverage is filled.
	{ country: "FI", hardFilterSafe: false, hardResolveRate: 0.695, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	{ country: "PL", hardFilterSafe: false, hardResolveRate: 0.778, measuredAt: "2026-06-22", source: OA_PANEL_SOURCE },
	// The postcodeCountryPrior format signal routes GB/CA confidently.
	// The OSM-panel checks passed with the hard filter on.
	// CA cleared on the format-prior rationale despite a sub-95% panel number,
	// so `hardFilterSafe` is a stored verdict rather than a rate threshold.
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
	// AU joined with the AU placer class.
	// The hard filter is recall-safe on the AU panel (unresolved 4→2 while abroad 43→20).
	// The receipt carries no single-rate number, so there is no `hardResolveRate` (never invent a magnitude).
	{
		country: "AU",
		hardFilterSafe: true,
		measuredAt: "2026-07-06",
		source: "#244 AU placer-class promote (2026-07-06): hard filter recall-safe (unresolved 4→2, abroad 43→20)",
	},
]

const BBOX_SOURCE = "2026-07-15 coordinate-parity receipt harness (scratchpad/coord-parity.mjs) — deliberately coarse"

/**
 * The reviewed guard-B bounding-box record, derived from `COUNTRY_BBOX`
 * (`resolver/plausibility.ts`) rather than declared beside it.
 *
 * Membership is checked in `plausibility.test.ts` against `release.config.json`.
 *
 * `source` is stamped here, because provenance belongs to the artifact record.
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
	 * The candidate DB under construction.
	 *
	 * It must be pre-seal (a shipped DB is never patched, rebuild instead).
	 */
	dbPath: PathBuilderLike
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
