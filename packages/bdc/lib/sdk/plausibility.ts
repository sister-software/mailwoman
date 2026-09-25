/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Collects BDC filings and nearby infrastructure as evidence for one broadband claim. Evidence can
 *   support a claim, and missing coverage produces an abstention or a lower confidence.
 *
 *   The filing channel uses `geoid` when present and otherwise approximates the block with the point's
 *   H3 cell. The physical channel needs a coordinate, so a geoid-only claim skips it. Only fiber and
 *   fixed wireless have physical-plant categories.
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

const FIXED_WIRELESS_CODES = BroadbandTechnologyCategoryToCodeSet[BroadbandTechnologyCategory.FixedWireless]

/**
 * Broadband-service claim to check.
 * It needs a `geoid`, a `point` or a geocodable `address`.
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

/**
 * One evidence item: a filing, a nearby physical-plant hit or an abstention.
 *
 * A filing that does not match the claimed technology or speed still counts as
 * evidence, with `corroborates: false`.
 */
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
 * The observation members of {@link PlausibilityEvidence}, checked against the shared `Evidence` type.
 *
 * Abstentions are excluded because they record missing evidence.
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
	/** The claim has only a geoid, so the physical search has no coordinate. */
	| "no_coordinate"
	/** No physical-plant category applies to this technology. */
	| "not_applicable"

/**
 * Per-channel survey states behind `coverage_confidence`.
 */
export interface PlausibilityCoverageDetail {
	filing: PlausibilityCoverageAxisState
	physical: PlausibilityCoverageAxisState
}

/**
 * Result of {@link plausibilityCheck}.
 */
export interface PlausibilityBundle {
	claim: PlausibilityClaim
	evidence_found: PlausibilityEvidence[]
	/**
	 * How much of the area the layers surveyed, regardless of what evidence turned up.
	 *
	 * `high` requires both channels covered.
	 * It is `insufficient_survey_data` when neither channel is covered, or
	 * when the physical channel does not apply and filings are uncovered.
	 */
	coverage_confidence: "high" | "low" | "insufficient_survey_data"
	coverage_detail: PlausibilityCoverageDetail
	/**
	 * Filing lookup key: the exact `geoid`, or the H3 cell of the point as an approximation.
	 */
	block_resolution: "geoid" | "h3_cell_approximation"
	/**
	 * BDC vintage, or `null` when the BDC layer is unavailable.
	 */
	vintage: string | null
}

/**
 * The geocode fields this module reads.
 * It avoids a circular dependency on the `mailwoman` package.
 */
export interface GeocodeLike {
	lat: number | null
	lon: number | null
}

/**
 * Open POI lookup and its layer database.
 * The caller owns and closes both handles.
 */
export interface PlausibilityPOIDeps {
	lookup: POILookup
	schemadb: layerschemahandle & Pick<DatabaseClient, "destroy">
}

/**
 * Optional layers and services for {@link plausibilityCheck}.
 * A missing layer produces an abstention.
 */
export interface PlausibilityDeps {
	bdcDB?: DatabaseClient<BDCDatabase>
	poi?: PlausibilityPOIDeps
	geocode?: (address: string) => Promise<GeocodeLike>
}

/**
 * Physical-plant POI categories for each technology code.
 * Only fiber and fixed wireless have entries.
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
 * Rank of each speed bucket from `filing/landscape.ts`, slowest first.
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

	if (filingRank === undefined) return false

	const claimedRank = SPEED_BUCKET_RANK[speedBucketForDownloadSpeed(claim.claimedDownloadMbps)]!

	return filingRank >= claimedRank
}

/**
 * Collapse a channel state to covered, unknown or not applicable.
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
 * Throw unless a layer's recorded H3 spine resolution equals `BDC_H3_RESOLUTION`.
 *
 * The coverage lookup derives res-6 parents from res-9 cells, which only works at that resolution.
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
 * Collect filing and physical evidence for a claim into one bundle.
 *
 * The result has no "implausible" verdict, because missing evidence does not disprove a claim.
 */
export async function plausibilityCheck(claim: PlausibilityClaim, deps: PlausibilityDeps): Promise<PlausibilityBundle> {
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

	const blockResolution: PlausibilityBundle["block_resolution"] = claim.geoid ? "geoid" : "h3_cell_approximation"

	const pointCell = point
		? shortCellToInt(latLngToCell(point.coordinates[1], point.coordinates[0], BDC_H3_RESOLUTION) as H3Cell)
		: undefined

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
		// A claim without a geoid has a point, so `pointCell` is defined here.
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
