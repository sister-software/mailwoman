/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compose BDC filing and nearby infrastructure evidence for one broadband claim. Evidence can support a claim but
 *   never disprove it; missing coverage is reported as unknown or abstention.
 *
 *   Filing lookup uses `geoid` when available; otherwise it uses the point's H3 cell and marks the result as an
 *   approximation. Physical lookup independently requires a coordinate, supplied directly or geocoded from an
 *   address. A geoid-only claim therefore skips physical lookup and lowers coverage confidence.
 *
 *   Fiber maps to telecom exchanges, cabinets, and data centers; fixed wireless maps to communications towers.
 *   Other technologies have no physical falsifier and skip that channel. Filing rows remain positive evidence even
 *   when they do not corroborate the claimed technology or speed.
 *
 *   `coverage_confidence` describes survey coverage, not whether evidence was found. Both applicable channels covered
 *   yields `high`; unknown coverage lowers confidence, and two unknown channels yield `insufficient_survey_data`.
 *   A non-applicable physical channel cannot produce `high` from filing coverage alone. Each wired layer's recorded
 *   H3 spine resolution is checked against `BDC_H3_RESOLUTION` before its coverage data is joined.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { readLayerCoverage, readLayerManifest, type layerschemahandle } from "@mailwoman/core/layers"
import type { Evidence } from "@mailwoman/evidence"
import type { POILookup } from "@mailwoman/resolver-wof-sqlite/poi"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { latLngToCell } from "h3-js"

import { BDC_H3_RESOLUTION, type BDCDatabase } from "#schema"
import {
	BDC_SPEED_BUCKET_100_1000,
	BDC_SPEED_BUCKET_25_100,
	BDC_SPEED_BUCKET_GIGABIT,
	BDC_SPEED_BUCKET_UNDER_25,
	filingLandscape,
	res9ShortCellToRes6Parent,
	speedBucketForDownloadSpeed,
	type ProviderFilingSummary,
} from "#sdk/filing/landscape"
import { nearestInfrastructure, type InfrastructureHit } from "#sdk/nearest-infrastructure"
import {
	BroadbandTechnologyCategory,
	BroadbandTechnologyCategoryToCodeSet,
	BroadbandTechnologyCode,
} from "#sdk/technologies"

/**
 * Derive fixed-wireless codes from the shared technology category set.
 */
const FIXED_WIRELESS_CODES = BroadbandTechnologyCategoryToCodeSet[BroadbandTechnologyCategory.FixedWireless]

/**
 * Broadband-service claim to check.
 *
 * A usable `geoid`, `point`, or geocodable `address` is required.
 */
export interface PlausibilityClaim {
	address?: string
	point?: PointLiteral
	geoid?: string
	technologyCode: number
	claimedDownloadMbps: number
}

/**
 * Reasons an evidence channel may abstain.
 */
export type PlausibilityAbstainReason = "requires_build_local_layer" | "requires_bdc_layer" | "insufficient_survey_data"

export type PlausibilityEvidence =
	| {
			kind: "observation"
			type: "filing"
			source: "bdc"
			vintage: string
			filing: ProviderFilingSummary
			corroborates: boolean
	  }
	| { kind: "observation"; type: "physical_plant"; source: "poi"; vintage: string; hit: InfrastructureHit }
	| { type: "abstain"; reason: PlausibilityAbstainReason; layer?: string }

/**
 * Observations retain their existing fields and add a shared `kind` discriminator.
 *
 * Abstentions are not observations: they describe unavailable evidence, not a finding.
 */
export type PlausibilitySharedEvidence =
	Extract<PlausibilityEvidence, { kind: "observation" }> extends Evidence
		? Extract<PlausibilityEvidence, { kind: "observation" }>
		: never

/**
 * Survey state for one channel.
 *
 * `no_coordinate` and `not_applicable` apply only to physical coverage.
 */
export type PlausibilityCoverageAxisState =
	| "covered"
	/** The required BDC or POI dependency is not configured. */
	| "layer_missing"
	/** The dependency exists, but the queried block or cell is unsurveyed. */
	| "cell_unsurveyed"
	/** Physical axis only: a geoid-only claim provides no search coordinate. */
	| "no_coordinate"
	/** Physical axis only: no physical-plant category applies to this technology. */
	| "not_applicable"

/**
 * Per-channel explanation for `coverage_confidence`, reported alongside its stable summary field.
 */
export interface PlausibilityCoverageDetail {
	filing: PlausibilityCoverageAxisState
	physical: PlausibilityCoverageAxisState
}

export interface PlausibilityBundle {
	claim: PlausibilityClaim
	evidence_found: PlausibilityEvidence[]
	coverage_confidence: "high" | "low" | "insufficient_survey_data"
	/**
	 * Per-channel explanation for coverage confidence.
	 */
	coverage_detail: PlausibilityCoverageDetail
	/**
	 * Filing lookup key: exact `geoid`, or approximate H3 cell from a point/address.
	 */
	block_resolution: "geoid" | "h3_cell_approximation"
	/**
	 * BDC vintage, or `null` when the BDC layer is unavailable.
	 */
	vintage: string | null
}

/**
 * Minimal geocoding result used here, avoiding a circular dependency on the `mailwoman` workspace.
 */
export interface GeocodeLike {
	lat: number | null
	lon: number | null
}

/**
 * Open POI lookup and coverage database.
 *
 * The caller owns both handles; the database supports hit and cell-coverage reads.
 */
export interface PlausibilityPOIDeps {
	lookup: POILookup
	schemadb: layerschemahandle & Pick<DatabaseClient, "destroy">
}

export interface PlausibilityDeps {
	bdcDB?: DatabaseClient<BDCDatabase>
	poi?: PlausibilityPOIDeps
	geocode?: (address: string) => Promise<GeocodeLike>
}

/**
 * Map fiber and fixed-wireless technologies to physical-plant categories; other codes have no mapping.
 */
export const PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES: Readonly<Record<number, readonly string[]>> = {
	[BroadbandTechnologyCode.OpticalCarrierFiber]: ["telecom_exchange", "telecom_cabinet", "data_center"],
	...(Object.fromEntries([...FIXED_WIRELESS_CODES].map((code) => [code, ["tower_comms"]])) as Record<
		number,
		readonly string[]
	>),
}

/**
 * Return applicable physical-plant categories, or `[]` when none apply.
 */
export function physicalCategoriesForTechnology(technologyCode: number): readonly string[] {
	return PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES[technologyCode] ?? []
}

/**
 * Numeric ordering of speed buckets, matching `filing-landscape.ts`.
 */
const SPEED_BUCKET_RANK: Readonly<Record<string, number>> = {
	[BDC_SPEED_BUCKET_UNDER_25]: 0,
	[BDC_SPEED_BUCKET_25_100]: 1,
	[BDC_SPEED_BUCKET_100_1000]: 2,
	[BDC_SPEED_BUCKET_GIGABIT]: 3,
}

/**
 * Check whether a filing matches the claimed technology and meets or exceeds its speed bucket.
 */
function filingCorroborates(filing: ProviderFilingSummary, claim: PlausibilityClaim): boolean {
	if (filing.technology_code !== claim.technologyCode) return false

	const filingRank = SPEED_BUCKET_RANK[filing.speed_bucket]

	// Unknown buckets cannot corroborate.
	if (filingRank === undefined) return false

	const claimedRank = SPEED_BUCKET_RANK[speedBucketForDownloadSpeed(claim.claimedDownloadMbps)]!

	return filingRank >= claimedRank
}

/**
 * Map detailed channel states to the values used by coverage combination.
 */
function confidenceStateForAxis(state: PlausibilityCoverageAxisState): "covered" | "unknown" | "not_applicable" {
	if (state === "covered") return "covered"

	if (state === "not_applicable") return "not_applicable"

	return "unknown"
}

/**
 * Combine channel coverage states into the bundle confidence.
 */
function combineCoverage(
	filingState: PlausibilityCoverageAxisState,
	physicalState: PlausibilityCoverageAxisState
): PlausibilityBundle["coverage_confidence"] {
	const filing = confidenceStateForAxis(filingState)
	const physical = confidenceStateForAxis(physicalState)

	if (physical === "not_applicable") {
		return filing === "covered" ? "low" : "insufficient_survey_data"
	}

	if (filing === "covered" && physical === "covered") return "high"

	if (filing === "unknown" && physical === "unknown") return "insufficient_survey_data"

	return "low"
}

/**
 * Ensure a wired layer's recorded H3 spine resolution matches the constant
 * used by filing and coverage lookups.
 */
async function assertLayerSpineResolution(
	layer: "bdc" | "poi",
	schemadb: layerschemahandle & Pick<DatabaseClient, "destroy">,
	expectedResolution: number
): Promise<void> {
	const manifest = await readLayerManifest(schemadb)
	const resolution = manifest.spineKeys.h3?.resolution

	if (resolution === undefined || resolution !== expectedResolution) {
		throw new Error(
			`plausibilityCheck: ${layer}.db's recorded h3 spine resolution (${String(resolution)}) does not match ` +
				`BDC_H3_RESOLUTION (${expectedResolution}) — the res-9→res-6 coverage-cell reconstruction this scorer ` +
				`relies on assumes they match; refusing to compose evidence against a mismatched layer rather than ` +
				`silently mis-joining a coverage cell.`
		)
	}
}

/**
 * Combine filing and physical evidence in one bundle.
 * Missing evidence never produces an "implausible" verdict.
 */
export async function plausibilityCheck(claim: PlausibilityClaim, deps: PlausibilityDeps): Promise<PlausibilityBundle> {
	// Resolve a physical-search coordinate independently of the filing lookup key.
	let point: PointLiteral | undefined = claim.point

	if (!point && claim.address) {
		if (!deps.geocode) {
			throw new Error("plausibilityCheck: claim.address requires deps.geocode")
		}

		const geocoded = await deps.geocode(claim.address)

		if (geocoded.lat == null || geocoded.lon == null) {
			throw new Error(`plausibilityCheck: geocode could not resolve a coordinate for ${stringifyJSON(claim.address)}`)
		}

		point = { type: "Point", coordinates: [geocoded.lon, geocoded.lat] }
	}

	if (!claim.geoid && !point) {
		throw new Error("plausibilityCheck: claim must supply one of `geoid`, `point`, or a resolvable `address`")
	}

	// Prefer the exact geoid path; otherwise use the point's approximate H3 cell.
	const blockResolution: PlausibilityBundle["block_resolution"] = claim.geoid ? "geoid" : "h3_cell_approximation"

	const pointCell = point
		? shortCellToInt(latLngToCell(point.coordinates[1], point.coordinates[0], BDC_H3_RESOLUTION) as H3Cell)
		: undefined

	// Validate each wired layer independently before joining coverage cells.
	if (deps.bdcDB) {
		await assertLayerSpineResolution("bdc", deps.bdcDB, BDC_H3_RESOLUTION)
	}

	if (deps.poi) {
		await assertLayerSpineResolution("poi", deps.poi.schemadb, BDC_H3_RESOLUTION)
	}

	const evidence: PlausibilityEvidence[] = []
	let vintage: string | null = null
	let filingCoverage: PlausibilityCoverageAxisState = "layer_missing"

	if (!deps.bdcDB) {
		evidence.push({ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" })
	} else {
		// A non-geoid claim must have a resolved point, so its H3 cell is defined.
		const landscape =
			blockResolution === "geoid"
				? await filingLandscape(deps.bdcDB, { geoids: [claim.geoid!] })
				: await filingLandscape(deps.bdcDB, { h3Cells: [pointCell!] })

		vintage = landscape.vintage

		if (landscape.surveyed_block_count > 0) {
			filingCoverage = "covered"

			for (const filing of landscape.filings) {
				evidence.push({
					kind: "observation",
					type: "filing",
					source: "bdc",
					filing,
					vintage: landscape.vintage,
					corroborates: filingCorroborates(filing, claim),
				})
			}
		} else {
			filingCoverage = "cell_unsurveyed"
			evidence.push({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
		}
	}

	const physicalCategories = physicalCategoriesForTechnology(claim.technologyCode)
	let physicalCoverage: PlausibilityCoverageAxisState = "not_applicable"

	if (physicalCategories.length) {
		if (!deps.poi) {
			physicalCoverage = "layer_missing"
			evidence.push({ type: "abstain", reason: "requires_build_local_layer", layer: "poi" })
		} else if (!point) {
			// A geoid-only claim has no search point; mark the capability gap without fabricating evidence.
			physicalCoverage = "no_coordinate"
		} else {
			const hits = await nearestInfrastructure(deps.poi.lookup, deps.poi.schemadb, {
				center: point,
				categoryIDs: [...physicalCategories],
			})

			const poiVintage = (await readLayerManifest(deps.poi.schemadb)).sourceVintage

			for (const hit of hits) {
				evidence.push({ kind: "observation", type: "physical_plant", source: "poi", vintage: poiVintage, hit })
			}

			const coverageCell = await readLayerCoverage(deps.poi.schemadb, res9ShortCellToRes6Parent(pointCell!))
			physicalCoverage = coverageCell ? "covered" : "cell_unsurveyed"
		}
	}

	return {
		claim,
		evidence_found: evidence,
		coverage_confidence: combineCoverage(filingCoverage, physicalCoverage),
		coverage_detail: { filing: filingCoverage, physical: physicalCoverage },
		block_resolution: blockResolution,
		vintage,
	}
}
