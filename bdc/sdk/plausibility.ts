/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `plausibilityCheck` (2b task 5, spec §3.2/§4) — the heart of the BDC plausibility vertical. Composes
 *   `filingLandscape` (2a) + `nearestInfrastructure` (2b task 4) into ONE evidence bundle over a single
 *   broadband-service claim, under the registry-backed doctrine's positive-evidence-only invariant (spec
 *   §4): a BDC filing or a nearby infrastructure hit can RAISE confidence; their absence can only ever
 *   read as "unknown" or "no supporting evidence found, coverage permitting" — NEVER as "implausible."
 *   The four §7-2b acceptance gates land in Task 6 as their own test file; this module is designed for
 *   them but doesn't assert them itself.
 *
 *   **Claim resolution (decision 4).** A claim's spatial key resolves two INDEPENDENT ways:
 *
 *   - **Filing evidence's spatial key**: `claim.geoid` wins outright when present — `filingLandscape({
 *     geoids: [claim.geoid] })` is the NATIVE, exact path (no h3 approximation needed), so
 *     `block_resolution` is `"geoid"`. Otherwise a coordinate is required (`claim.point` directly, or
 *     `claim.address` geocoded via `deps.geocode`) and filing evidence goes through
 *     `filingLandscape({ h3Cells: [cell] })` — this is the UNSOUND h3-cell approximation decision 4
 *     pins (a claim's own res-9 cell can differ from its true block centroid's cell), so
 *     `block_resolution` is `"h3_cell_approximation"`. Only one of the two is ever emitted — the union
 *     type is deliberately NOT `("geoid" | "h3_cell_approximation")[]`.
 *   - **Physical evidence's search center**: independent of the above — `claim.point` (or the geocoded
 *     `claim.address`) directly, whenever available. A GEOID-ONLY claim (no point, no address) has NO
 *     coordinate to search from: bdc.db stores no public geoid→centroid resolver (deriving one would
 *     need the same Fabric-adjacent block-centroid machinery the vertical explicitly keeps out of reach
 *     — §2.2's boundary), so physical evidence is skipped entirely for that shape of claim. This is a
 *     genuine, documented capability gap, not a missing-layer abstain: `coverage_confidence` still
 *     degrades honestly (see below), but no `PlausibilityEvidence` abstain variant fits "no coordinate
 *     available," so none is fabricated.
 *
 *   **Tech → physical-category mapping (decision 8's "reuse, never re-derive" extended to this table).**
 *   {@link PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES}: fiber (`OpticalCarrierFiber`, code 50) implies
 *   `telecom_exchange`/`telecom_cabinet`/`data_center`; the three fixed-wireless codes (70/71/72) imply
 *   `tower_comms`; every other code (DSL, cable, satellite, power-line, other) maps to `[]` — no physical
 *   falsifier is claimed for those technologies, because OSM/Overture carry no plant category that
 *   physically falsifies them. A `[]` mapping means the physical-evidence step is skipped as
 *   NOT-APPLICABLE (distinct from "layer missing" — see `coverage_confidence` below).
 *
 *   **Filing evidence.** Every `ProviderFilingSummary` row `filingLandscape` returns for the resolved
 *   block becomes its own `{ type: "filing" }` evidence entry (ANY provider filing there is positive
 *   evidence a market exists, informative regardless of tech match — spec §3.2 step 2's "a filing that
 *   contradicts it… weak signal, not disproof"). `corroborates` is true only when the filing's
 *   `technology_code` matches the claim AND its `speed_bucket` ranks at or above the claimed download
 *   speed's own bucket (via the exported {@link speedBucketForDownloadSpeed} + the four bucket consts —
 *   decision 8: reused, never re-derived). A same-tech LESSER filing, or a different-tech filing, is
 *   still emitted with `corroborates: false` — never treated as disproof of anything.
 *
 *   - bdc.db absent entirely → one `{ type: "abstain", reason: "requires_bdc_layer" }` entry (decision
 *     6); `vintage` stays `null` — the ONLY case it does (per the produced type's own doc comment).
 *   - bdc.db present but the resolved block/cell itself carries no survey evidence (`unknown_block_count`
 *     > 0 for the one queried unit) → `{ type: "abstain", reason: "insufficient_survey_data", layer:
 *     "bdc" }`. `vintage` IS still populated here — the LAYER didn't abstain, only this one cell lacks
 *     coverage.
 *   - bdc.db present, block surveyed, zero filings → the spec's POSITIVE meaning-of-zero case ("a
 *     genuine 'surveyed, zero providers here' result" — `filing-landscape.ts`'s own docstring). No
 *     `filing` evidence entries are pushed (there's nothing to report), but the filing layer still
 *     counts as COVERED for `coverage_confidence` — the absence is informative, not unknown.
 *
 *   **Physical evidence.** Symmetric to the above, over `nearestInfrastructure`'s hits — every hit
 *   becomes its own `{ type: "physical_plant" }` entry, nearest-first, whatever `nearestInfrastructure`'s
 *   own ring/limit budget returns.
 *
 *   - The tech maps to `[]` categories (no physical falsifier claimed) → the step is skipped outright;
 *     no evidence entry, no abstain, and this axis is excluded from `coverage_confidence` (see below).
 *   - The tech implies categories but `deps.poi` is absent → `{ type: "abstain", reason:
 *     "requires_build_local_layer", layer: "poi" }` (decision 6 — the poi-executor abstain precedent).
 *   - The tech implies categories, `deps.poi` is present, but no coordinate is resolvable (a geoid-only
 *     claim) → no evidence entry, no abstain (see the claim-resolution note above); the axis degrades to
 *     UNKNOWN for `coverage_confidence` purposes.
 *   - Otherwise → `nearestInfrastructure` runs; each hit is emitted, and the searched point's OWN res-6
 *     coverage cell (independent of whether any hit was found — a covered-but-empty cell is real
 *     evidence the area was surveyed) is read directly via `readLayerCoverage` to determine the layer's
 *     coverage state for this claim.
 *
 *   **`coverage_confidence` — survey completeness, NOT evidence-found.** This is deliberately orthogonal
 *   to whether any evidence was actually found (spec §4 rule 4: "coverage_confidence is mandatory on
 *   every answer… the product's honesty is this refusal to guess" — a refusal that has to hold even when
 *   the answer turns out to be "nothing found"). Each layer contributes one of `"covered"` / `"unknown"`
 *   / `"not_applicable"` (the last only for the physical axis, when the tech maps to no category), and
 *   the pair combines per the brief's literal formula: both covered → `"high"`; either UNKNOWN → degrade
 *   to `"low"`; both absent/unknown → `"insufficient_survey_data"`.
 *
 *   The `"not_applicable"` extension (not literally spelled out in the brief, since the brief's formula
 *   assumes a real pair) is this module's own documented decision, deliberately CONSERVATIVE: a tech with
 *   no physical falsifier (DSL, cable, satellite, power-line) can never reach `"high"` confidence from
 *   filing coverage alone — it degrades to filing-covered → `"low"`, filing-unknown/absent →
 *   `"insufficient_survey_data"`. Rationale: spec §4 frames physical co-presence as the vertical's
 *   distinguishing "falsifier that only fires positively" and reserves `"high"` for genuine two-channel
 *   corroboration (Gate 2 in Task 6: "matching filing + nearby plant in covered cells… high"); a tech
 *   that structurally can never offer a second channel should not be able to claim the same top
 *   confidence a fiber claim earns by actually having one available. This reading is more conservative
 *   than the alternative (treating the missing axis as inert and reporting `"high"` off filing alone) —
 *   flagged here for review since Task 6's four gates don't exercise a no-physical-falsifier tech code.
 *
 *   **Ledger note (task 4 review) — the cross-layer coverage-resolution sanity check.** Neither bdc.db's
 *   nor poi.db's `layer_manifest` records the COVERAGE-cell h3 resolution (6) that
 *   `res9ShortCellToRes6Parent` hardcodes on both sides — only each layer's ROW-spine resolution (9,
 *   `spineKeys.h3.resolution`) is ever recorded. A real fix needs a layer-contract schema addition (out
 *   of scope for this task; the same follow-up task 4's report already ticketed). What IS practical and
 *   cheap: both manifests are single-row tables already read at most once per call here, so whenever
 *   BOTH `bdcDB` and `poi` are wired, {@link assertCoverageSpineAgreement} cross-checks the one thing
 *   that IS recorded — the two layers' `spineKeys.h3.resolution` — and throws if they disagree, catching
 *   a future layer built at a different spine resolution before it silently mis-joins a coverage cell.
 *   It can NOT catch a layer whose row spine is 9 but whose COVERAGE cells were derived at some OTHER
 *   resolution than 6 — that gap needs the schema addition, not a runtime assertion.
 */

import type { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import type { POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import type { Kysely } from "kysely"

import { BDC_H3_RESOLUTION, type BDCDatabase } from "../schema.ts"
import {
	BDC_SPEED_BUCKET_100_1000,
	BDC_SPEED_BUCKET_25_100,
	BDC_SPEED_BUCKET_GIGABIT,
	BDC_SPEED_BUCKET_UNDER_25,
	filingLandscape,
	res9ShortCellToRes6Parent,
	speedBucketForDownloadSpeed,
	type ProviderFilingSummary,
} from "./filing-landscape.ts"
import { nearestInfrastructure, type InfrastructureHit } from "./nearest-infrastructure.ts"
import { BroadbandTechnologyCode } from "./technologies.ts"

/**
 * One claimed broadband-service assertion to check. Exactly one spatial field is expected in practice (`geoid` wins if
 * present — see the module docstring's claim-resolution note); `plausibilityCheck` throws if NONE of
 * `geoid`/`point`/`address` resolves to something usable.
 */
export interface PlausibilityClaim {
	address?: string
	point?: PointLiteral
	geoid?: string
	technologyCode: number
	claimedDownloadMbps: number
}

/**
 * Reasons `plausibilityCheck` can abstain on one evidence channel — decision 6, the poi-executor abstain precedent
 * (`mailwoman/poi-executor.ts`), extended with the bdc-layer-absent case and the survey-gap-for-this-cell case.
 */
export type PlausibilityAbstainReason = "requires_build_local_layer" | "requires_bdc_layer" | "insufficient_survey_data"

export type PlausibilityEvidence =
	| { type: "filing"; filing: ProviderFilingSummary; vintage: string; corroborates: boolean }
	| { type: "physical_plant"; hit: InfrastructureHit }
	| { type: "abstain"; reason: PlausibilityAbstainReason; layer?: string }

export interface PlausibilityBundle {
	claim: PlausibilityClaim
	evidence_found: PlausibilityEvidence[]
	coverage_confidence: "high" | "low" | "insufficient_survey_data"
	/**
	 * `"geoid"` when `claim.geoid` drove the filing-evidence lookup (the exact, native path); otherwise
	 * `"h3_cell_approximation"` (decision 4 — the point/address path's unsound-but-flagged h3 cell). ALWAYS present on
	 * every returned bundle.
	 */
	block_resolution: "geoid" | "h3_cell_approximation"
	/**
	 * `null` ONLY when the bdc layer itself abstained (`deps.bdcDB` absent). Populated in every other case, including
	 * when the specific queried block/cell is itself unsurveyed.
	 */
	vintage: string | null
}

/**
 * Structural mirror of `mailwoman/geocode-core.ts`'s `GeocodeResult` — `@mailwoman/bdc` MUST NOT import from the
 * `mailwoman` workspace (`mailwoman/package.json` already depends on `@mailwoman/bdc`; the reverse edge would be
 * circular). Only the two fields this scorer actually consumes are typed here; a real `GeocodeResult` is structurally
 * assignable to this type without any adapter, so a caller wiring `deps.geocode` at the CLI/MCP layer can pass a thin
 * wrapper over `geocodeAddress` directly.
 */
export interface GeocodeLike {
	lat: number | null
	lon: number | null
}

/**
 * The already-open infra layer this scorer composes against Task 4's `nearestInfrastructure`. The caller owns BOTH
 * handles' open/dispose lifecycle (mirrors `nearestInfrastructure`'s own `using poiLookup = new POILookup(...)`
 * precedent). `contractDB` is used two ways: passed straight through to `nearestInfrastructure` (per-hit coverage), and
 * read directly here (the whole-cell coverage check this module needs for `coverage_confidence`, independent of whether
 * any hit was actually found).
 */
export interface PlausibilityPOIDeps {
	lookup: POILookup
	contractDB: DatabaseClient<LayerContractDatabase>
}

export interface PlausibilityDeps {
	bdcDB?: DatabaseClient<BDCDatabase>
	poi?: PlausibilityPOIDeps
	geocode?: (address: string) => Promise<GeocodeLike>
}

/**
 * Tech → physical-plant category mapping (exported per the task brief). Fiber implies the three
 * infrastructure-extension categories a fiber network plausibly touches; the three fixed-wireless codes imply a comms
 * tower; every other code maps to `[]` — no physical falsifier is claimed for it (see
 * {@link physicalCategoriesForTechnology}).
 */
export const PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES: Readonly<Record<number, readonly string[]>> = {
	[BroadbandTechnologyCode.OpticalCarrierFiber]: ["telecom_exchange", "telecom_cabinet", "data_center"],
	[BroadbandTechnologyCode.UnlicensedTerrestrialFixedWireless]: ["tower_comms"],
	[BroadbandTechnologyCode.LicensedTerrestrialFixedWireless]: ["tower_comms"],
	[BroadbandTechnologyCode.LicensedByRuleTerrestrialFixedWireless]: ["tower_comms"],
}

/**
 * The poi-taxonomy category ids a physical-plant search should probe for a given BDC technology code, or `[]` when that
 * technology has no physical falsifier in this vertical (see {@link PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES}).
 */
export function physicalCategoriesForTechnology(technologyCode: number): readonly string[] {
	return PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES[technologyCode] ?? []
}

/**
 * Ordinal rank of each `speed_bucket` label, so "at or above claimed speed" is a numeric comparison rather than a
 * string one. Mirrors the bucket ORDER `filing-landscape.ts` defines (never re-derived — decision 8).
 */
const SPEED_BUCKET_RANK: Readonly<Record<string, number>> = {
	[BDC_SPEED_BUCKET_UNDER_25]: 0,
	[BDC_SPEED_BUCKET_25_100]: 1,
	[BDC_SPEED_BUCKET_100_1000]: 2,
	[BDC_SPEED_BUCKET_GIGABIT]: 3,
}

/**
 * `BDCDatabase extends LayerContractDatabase` structurally, but Kysely's `transaction()` makes `Kysely<DB>` INVARIANT
 * in `DB` — same cast idiom as `filing-landscape.ts`'s own private `asContractDB` (decision 8: reuse, never re-derive;
 * copied rather than imported since the original is module-private).
 */
function asContractDB(kdb: DatabaseClient<BDCDatabase>): Kysely<LayerContractDatabase> {
	return kdb as unknown as Kysely<LayerContractDatabase>
}

/**
 * `true` when `filing` corroborates the claim: same `technology_code`, AND `filing.speed_bucket` ranks at or above the
 * claimed download speed's own bucket. A different tech, or a same-tech but LESSER filing, is `false` — never disproof,
 * just non-corroborating (spec §3.2 step 2).
 */
function filingCorroborates(filing: ProviderFilingSummary, claim: PlausibilityClaim): boolean {
	if (filing.technology_code !== claim.technologyCode) return false

	const filingRank = SPEED_BUCKET_RANK[filing.speed_bucket]

	// An unrecognized speed_bucket (a corrupted/foreign row) can't corroborate — never guess a rank for it.
	if (filingRank === undefined) return false

	const claimedRank = SPEED_BUCKET_RANK[speedBucketForDownloadSpeed(claim.claimedDownloadMbps)]!

	return filingRank >= claimedRank
}

/**
 * One evidence channel's survey-completeness state for THIS claim — `"not_applicable"` is only ever produced for the
 * physical axis (the tech maps to no physical category at all).
 */
type CoverageState = "covered" | "unknown" | "not_applicable"

/**
 * Combine the two layers' coverage states into the bundle's `coverage_confidence` — see the module docstring for the
 * `"not_applicable"` extension's reasoning (deliberately conservative: never `"high"` without a real, applicable
 * two-channel opportunity).
 */
function combineCoverage(
	filingState: CoverageState,
	physicalState: CoverageState
): PlausibilityBundle["coverage_confidence"] {
	if (physicalState === "not_applicable") {
		return filingState === "covered" ? "low" : "insufficient_survey_data"
	}

	if (filingState === "covered" && physicalState === "covered") return "high"

	if (filingState === "unknown" && physicalState === "unknown") return "insufficient_survey_data"

	return "low"
}

/**
 * See the module docstring's "ledger note" section. Throws when both manifests are readable but disagree on their
 * recorded h3 spine resolution — the one cross-layer fact that IS recorded, and the closest available proxy for the
 * (unrecorded) coverage-cell resolution both layers' `res9ShortCellToRes6Parent` calls assume they share.
 */
async function assertCoverageSpineAgreement(
	bdcDB: DatabaseClient<BDCDatabase>,
	poiContractDB: Kysely<LayerContractDatabase>
): Promise<void> {
	const [bdcManifest, poiManifest] = await Promise.all([
		readLayerManifest(asContractDB(bdcDB)),
		readLayerManifest(poiContractDB),
	])

	const bdcResolution = bdcManifest.spineKeys.h3?.resolution
	const poiResolution = poiManifest.spineKeys.h3?.resolution

	if (bdcResolution === undefined || poiResolution === undefined || bdcResolution !== poiResolution) {
		throw new Error(
			`plausibilityCheck: bdc.db and poi.db disagree on their recorded h3 spine resolution ` +
				`(bdc=${String(bdcResolution)}, poi=${String(poiResolution)}) — the res-9→res-6 coverage-cell ` +
				`reconstruction this scorer relies on assumes they match; refusing to compose evidence across ` +
				`mismatched layers rather than silently mis-joining a coverage cell.`
		)
	}
}

/**
 * Compose filing evidence + physical evidence into one `{ claim, evidence_found, coverage_confidence }` bundle — see
 * the module docstring for the full composition rules. Never emits anything expressible as "implausible": absence of a
 * filing or of nearby plant only ever surfaces as an abstain, an omitted evidence entry, or a degraded
 * `coverage_confidence` — never a negative verdict.
 */
export async function plausibilityCheck(claim: PlausibilityClaim, deps: PlausibilityDeps): Promise<PlausibilityBundle> {
	// 1. Resolve a coordinate for physical-evidence search (independent of the filing-evidence spatial key below) —
	// claim.point directly, or claim.address geocoded via deps.geocode.
	let point: PointLiteral | undefined = claim.point

	if (!point && claim.address) {
		if (!deps.geocode) {
			throw new Error("plausibilityCheck: claim.address requires deps.geocode")
		}

		const geocoded = await deps.geocode(claim.address)

		if (geocoded.lat == null || geocoded.lon == null) {
			throw new Error(`plausibilityCheck: geocode could not resolve a coordinate for ${JSON.stringify(claim.address)}`)
		}

		point = { type: "Point", coordinates: [geocoded.lon, geocoded.lat] }
	}

	if (!claim.geoid && !point) {
		throw new Error("plausibilityCheck: claim must supply one of `geoid`, `point`, or a resolvable `address`")
	}

	// decision 4: geoid wins outright — the exact, native filing-evidence path. Otherwise the resolved point's own
	// res-9 cell is the (flagged, unsound) approximation.
	const blockResolution: PlausibilityBundle["block_resolution"] = claim.geoid ? "geoid" : "h3_cell_approximation"

	const pointCell = point
		? shortCellToInt(latLngToCell(point.coordinates[1], point.coordinates[0], BDC_H3_RESOLUTION) as H3Cell)
		: undefined

	// Ledger note (task 4 review): cheap, one-time cross-layer sanity check — see the module docstring.
	if (deps.bdcDB && deps.poi) {
		await assertCoverageSpineAgreement(deps.bdcDB, deps.poi.contractDB)
	}

	const evidence: PlausibilityEvidence[] = []
	let vintage: string | null = null
	let filingCoverage: CoverageState = "unknown"

	if (!deps.bdcDB) {
		evidence.push({ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" })
	} else {
		// blockResolution === "geoid" iff claim.geoid is set (see above), so exactly one of these two branches ever
		// runs, and the `pointCell!` assertion below is safe: blockResolution === "h3_cell_approximation" only when
		// claim.geoid is absent, which (per the throw above) means `point` — and therefore `pointCell` — is defined.
		const landscape =
			blockResolution === "geoid"
				? await filingLandscape(deps.bdcDB, { geoids: [claim.geoid!] })
				: await filingLandscape(deps.bdcDB, { h3Cells: [pointCell!] })

		vintage = landscape.vintage

		if (landscape.surveyed_block_count > 0) {
			filingCoverage = "covered"

			for (const filing of landscape.filings) {
				evidence.push({
					type: "filing",
					filing,
					vintage: landscape.vintage,
					corroborates: filingCorroborates(filing, claim),
				})
			}
		} else {
			evidence.push({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
		}
	}

	const physicalCategories = physicalCategoriesForTechnology(claim.technologyCode)
	let physicalCoverage: CoverageState = "not_applicable"

	if (physicalCategories.length) {
		if (!deps.poi) {
			physicalCoverage = "unknown"
			evidence.push({ type: "abstain", reason: "requires_build_local_layer", layer: "poi" })
		} else if (!point) {
			// Geoid-only claim, no coordinate resolvable — see the module docstring's claim-resolution note. A real
			// capability gap, not a missing-layer abstain: no evidence entry is fabricated, but the axis still
			// degrades honestly for coverage_confidence.
			physicalCoverage = "unknown"
		} else {
			const hits = await nearestInfrastructure(deps.poi.lookup, deps.poi.contractDB, {
				center: point,
				categoryIDs: [...physicalCategories],
			})

			for (const hit of hits) {
				evidence.push({ type: "physical_plant", hit })
			}

			const coverageCell = await readLayerCoverage(deps.poi.contractDB, res9ShortCellToRes6Parent(pointCell!))
			physicalCoverage = coverageCell ? "covered" : "unknown"
		}
	}

	return {
		claim,
		evidence_found: evidence,
		coverage_confidence: combineCoverage(filingCoverage, physicalCoverage),
		block_resolution: blockResolution,
		vintage,
	}
}
