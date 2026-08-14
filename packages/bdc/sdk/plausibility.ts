/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `plausibilityCheck` (spec §3.2/§4) — the heart of the BDC plausibility vertical. Composes
 *   `filingLandscape` (`bdc/sdk/filing-landscape.ts`) + `nearestInfrastructure` into ONE evidence bundle
 *   over a single broadband-service claim, under the registry-backed doctrine's positive-evidence-only
 *   invariant (spec §4): a BDC filing or a nearby infrastructure hit can RAISE confidence; their absence
 *   can only ever read as "unknown" or "no supporting evidence found, coverage permitting" — NEVER as
 *   "implausible." The four §7-2b acceptance gates are asserted in `plausibility.test.ts`'s
 *   `describe("§7-2b gates")` block; this module is designed for them but doesn't assert them itself.
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
 *   corroboration (§7-2b Gate 2: "matching filing + nearby plant in covered cells… high"); a tech
 *   that structurally can never offer a second channel should not be able to claim the same top
 *   confidence a fiber claim earns by actually having one available. This reading is more conservative
 *   than the alternative (treating the missing axis as inert and reporting `"high"` off filing alone),
 *   and nothing pins it: none of the four §7-2b gates exercises a no-physical-falsifier tech code.
 *
 *   **The per-layer coverage-resolution sanity check.** Neither bdc.db's nor poi.db's `layer_manifest`
 *   records the COVERAGE-cell h3 resolution (6) that `res9ShortCellToRes6Parent` hardcodes on both sides
 *   — only each layer's ROW-spine resolution (9, `spineKeys.h3.resolution`) is ever recorded. Closing
 *   that gap properly needs an addition to the layer contract itself (`@mailwoman/core/layers`), which
 *   does not exist yet. What IS practical and
 *   cheap: each manifest is a single-row table already read at most once per call here, so whenever a layer is
 *   WIRED — `bdcDB`, `poi`, or both, checked independently — {@link assertLayerSpineResolution} compares that one
 *   layer's recorded `spineKeys.h3.resolution` directly against the `BDC_H3_RESOLUTION` constant `pointCell` is
 *   actually derived from, and throws on a mismatch, catching a layer built at a different spine resolution before it
 *   silently mis-joins a coverage cell. This is TWO-SIDED, not gated on both layers being present together: a
 *   poi-only call still checks poi's own recorded resolution, since `readLayerCoverage`'s poi-side join key (below)
 *   is derived from `BDC_H3_RESOLUTION` regardless of whether `bdcDB` is wired at all — comparing each manifest
 *   against the constant, rather than the two manifests against each other, is what makes a single-layer call
 *   checkable at all. It
 *   can NOT catch a layer whose row spine is 9 but whose COVERAGE cells were derived at some OTHER resolution than 6
 *   — that gap needs the schema addition, not a runtime assertion.
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
import {
	BroadbandTechnologyCategory,
	BroadbandTechnologyCategoryToCodeSet,
	BroadbandTechnologyCode,
} from "./technologies.ts"

/**
 * The three fixed-wireless codes (unlicensed/licensed/licensed-by-rule), read off
 * {@link BroadbandTechnologyCategoryToCodeSet} (decision 8: reuse, never re-derive) rather than hand-enumerated here a
 * second time — an FCC code addition to the `FixedWireless` category in `technologies.ts` now flows straight through to
 * {@link PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES} instead of silently missing this table.
 */
const FIXED_WIRELESS_CODES = BroadbandTechnologyCategoryToCodeSet[BroadbandTechnologyCategory.FixedWireless]

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

/**
 * One evidence channel's survey-completeness state for THIS claim, WITH the reason a non-`"covered"` state applies.
 * `coverage_confidence` alone folds several genuinely different situations into the same
 * `"low"`/`"insufficient_survey_data"` verdict (a tech with no physical falsifier at all vs. a real poi survey gap vs.
 * a geoid-only claim with no coordinate to search from); this axis state is what tells them apart. `"not_applicable"`
 * and `"no_coordinate"` are only ever produced for the physical axis; the filing axis only ever reaches `"covered"`,
 * `"layer_missing"`, or `"cell_unsurveyed"`.
 */
export type PlausibilityCoverageAxisState =
	| "covered"
	/**
	 * The required dependency (`deps.bdcDB` for filing, `deps.poi` for physical) was never wired at all — the
	 * `requires_bdc_layer` / `requires_build_local_layer` abstain precedent.
	 */
	| "layer_missing"
	/**
	 * The dependency IS wired, but the specific queried block/cell carries no survey coverage of its own — the
	 * `insufficient_survey_data` abstain precedent (filing), or an absent `readLayerCoverage` read (physical).
	 */
	| "cell_unsurveyed"
	/**
	 * Physical axis only: the claim resolved no coordinate (a geoid-only claim — see the module docstring's
	 * claim-resolution note), so no physical-evidence search point exists. A genuine capability gap, not a missing layer
	 * — distinct from `"layer_missing"` even though both degrade `coverage_confidence` the same way.
	 */
	| "no_coordinate"
	/**
	 * Physical axis only: the claimed technology maps to no physical-plant category at all (see
	 * {@link PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES}) — there is no applicable second channel for this tech, ever,
	 * regardless of layer availability. Distinct from every other state: this claim can never earn `"high"`.
	 */
	| "not_applicable"

/**
 * Per-axis attribution for {@link PlausibilityBundle.coverage_confidence} — see {@link PlausibilityCoverageAxisState}.
 * Reported alongside `coverage_confidence`, never in place of it: the coarse field stays the stable public surface.
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
	 * Per-axis WHY behind `coverage_confidence`. ALWAYS present, mirroring `block_resolution`'s always-present
	 * discipline.
	 */
	coverage_detail: PlausibilityCoverageDetail
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
 * The already-open infra layer this scorer composes against {@link nearestInfrastructure}. The caller owns BOTH
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
 * Tech → physical-plant category mapping. Fiber implies the three infrastructure-extension categories a fiber network
 * plausibly touches; the three fixed-wireless codes imply a comms tower; every other code maps to `[]` — no physical
 * falsifier is claimed for it (see {@link physicalCategoriesForTechnology}).
 */
export const PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES: Readonly<Record<number, readonly string[]>> = {
	[BroadbandTechnologyCode.OpticalCarrierFiber]: ["telecom_exchange", "telecom_cabinet", "data_center"],
	...(Object.fromEntries([...FIXED_WIRELESS_CODES].map((code) => [code, ["tower_comms"]])) as Record<
		number,
		readonly string[]
	>),
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
 * Collapse the fine-grained {@link PlausibilityCoverageAxisState} down to the 3-value space `combineCoverage` actually
 * reasons over: `"layer_missing"` and `"cell_unsurveyed"` are both simply UNKNOWN for confidence-combination purposes
 * (the distinction only matters for `coverage_detail`'s attribution, not for the confidence math itself).
 */
function confidenceStateForAxis(state: PlausibilityCoverageAxisState): "covered" | "unknown" | "not_applicable" {
	if (state === "covered") return "covered"

	if (state === "not_applicable") return "not_applicable"

	return "unknown"
}

/**
 * Combine the two layers' coverage states into the bundle's `coverage_confidence` — see the module docstring for the
 * `"not_applicable"` extension's reasoning (deliberately conservative: never `"high"` without a real, applicable
 * two-channel opportunity).
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
 * See the module docstring's coverage-resolution note. Throws when a WIRED layer's manifest disagrees with
 * `BDC_H3_RESOLUTION` — the single constant `plausibilityCheck` actually uses at runtime to derive both the
 * filing-lookup cell (bdc side, via `pointCell`) and the coverage-cell join key `readLayerCoverage` is read against
 * (poi side, via `res9ShortCellToRes6Parent(pointCell)`).
 *
 * Checked independently PER LAYER, whenever THAT layer is wired — not only when `bdcDB` and `poi` are wired together. A
 * poi-only call still needs poi's own recorded resolution checked, because `pointCell` is computed unconditionally from
 * `BDC_H3_RESOLUTION` and still drives the poi coverage-cell read below. Comparing each layer directly against the
 * constant, rather than the two manifests against each other, is also strictly stronger: it catches a layer built under
 * a since-changed `BDC_H3_RESOLUTION` even when the OTHER layer is absent entirely, not just a disagreement between two
 * present layers.
 */
async function assertLayerSpineResolution(
	layer: "bdc" | "poi",
	contractDB: Kysely<LayerContractDatabase>,
	expectedResolution: number
): Promise<void> {
	const manifest = await readLayerManifest(contractDB)
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

	// Cheap, one-time per-layer sanity check — see the module docstring's coverage-resolution note. Runs
	// independently per WIRED layer, not only when both are present: a poi-only call still joins poi's coverage
	// table against a BDC_H3_RESOLUTION-derived cell (below) and must not do so unchecked.
	if (deps.bdcDB) {
		await assertLayerSpineResolution("bdc", asContractDB(deps.bdcDB), BDC_H3_RESOLUTION)
	}

	if (deps.poi) {
		await assertLayerSpineResolution("poi", deps.poi.contractDB, BDC_H3_RESOLUTION)
	}

	const evidence: PlausibilityEvidence[] = []
	let vintage: string | null = null
	let filingCoverage: PlausibilityCoverageAxisState = "layer_missing"

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
			// Geoid-only claim, no coordinate resolvable — see the module docstring's claim-resolution note. A real
			// capability gap, not a missing-layer abstain: no evidence entry is fabricated, but the axis still
			// degrades honestly for coverage_confidence, naming ITS OWN reason in `coverage_detail` rather than
			// folding into the same generic "unknown" as `"layer_missing"`.
			physicalCoverage = "no_coordinate"
		} else {
			const hits = await nearestInfrastructure(deps.poi.lookup, deps.poi.contractDB, {
				center: point,
				categoryIDs: [...physicalCategories],
			})

			for (const hit of hits) {
				evidence.push({ type: "physical_plant", hit })
			}

			const coverageCell = await readLayerCoverage(deps.poi.contractDB, res9ShortCellToRes6Parent(pointCell!))
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
