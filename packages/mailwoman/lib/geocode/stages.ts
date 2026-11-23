// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The stages of the geocode path, their identifiers, and the records they write.
 *
 *   Each one runs through `runStage` in `@mailwoman/core/pipeline`, which times it,
 *   checks the request's abort signal before it, and hands it the request's trace.
 *
 *   The decode and the resolve are the parse pipeline's stages of the same name,
 *   so they keep its identifiers `token-classify` and `resolve`.
 */

import { placetypeMapForCountry } from "@mailwoman/codex/labels/placetype-map"
import type { AddressTree } from "@mailwoman/core/decoder"
import {
	type InputMode,
	type PipelineStage,
	type QueryKindResult,
	type RequestContext,
	runStage,
	StageID,
	type TreeRewriteRecord,
	treeRewriteStage,
} from "@mailwoman/core/pipeline"
import type {
	AddressPointLookup,
	DefaultCountry,
	RegionDatabases,
	ResolveOpts,
	Resolver,
} from "@mailwoman/core/resolver"
import type { NeuralParseTrace } from "@mailwoman/neural"
import type { QueryShape } from "@mailwoman/postcode/recognizer/query-shape"

import { recognizeBarePostcode } from "#geocode/rewrites/bare-postcode"
import { repairPostcodeContradiction } from "#geocode/rewrites/postcode-repair"
import { repairStrandedAffix } from "#geocode/rewrites/stranded-affix-repair"
import { recognizeUSRegions } from "#geocode/rewrites/us/region-recognition"
import { type CountryScopeDecision, type CountryScopeEvidence, decideCountryScope } from "#geocode/scope/inferred"
import { postcodeCountryScopeOf, resolvedCountryOf } from "#geocode/tree-reads"

/**
 * The identifier of each stage the geocode path adds to the parse pipeline's.
 * A timing record keys a stage's duration by its identifier.
 */
export const GeocodeStageID = {
	RegionRecognition: "region-recognition",
	BarePostcode: "bare-postcode",
	PostcodeContradiction: "postcode-contradiction",
	StrandedAffix: "stranded-affix",
	CountryScope: "country-scope",
	RooftopSelection: "rooftop-selection",
} as const

/**
 * One of the {@link GeocodeStageID} values.
 */
export type GeocodeStageID = (typeof GeocodeStageID)[keyof typeof GeocodeStageID]

/**
 * How a fault spells a decode trace that couldn't be built.
 *
 * The decode's tree is the answer all the same, and the run has no decode record.
 */
export const DECODE_TRACE_FAULT = "decode-trace"

/**
 * The decode that produced the answer's tree, with the inputs the parse derived for it.
 *
 * Written only for a request that traces in detail.
 */
export interface DecodeRecord {
	kind: "decode"
	stage: typeof StageID.TokenClassify
	parse: NeuralParseTrace
	queryShape: QueryShape
	/**
	 * The kind verdict behind {@link inputMode}, or null when the caller chose the register.
	 */
	queryKind: QueryKindResult | null
	inputMode: InputMode
}

/**
 * The country scope one resolve pass ran under.
 *
 * A geocode writes one when it decides the scope, and a second when a locale-inferred
 * scope left the address with zero coordinates and was withdrawn, so the last one
 * written is the scope the answer was resolved under.
 */
export interface CountryScopeRecord extends CountryScopeDecision {
	kind: "country-scope"
	stage: typeof GeocodeStageID.CountryScope
}

/**
 * Where a resolve's address points came from.
 *
 * - `"national"`: the country's national address database.
 * - `"osm"`: the country's OpenStreetMap database, read when it has no national one.
 * - `"region"`: the database of the tree's region, from the caller's region resolver.
 */
export type AddressPointSource = "national" | "osm" | "region"

/**
 * Which address-point source each resolve of one pass read, and why a second resolve ran.
 */
export interface RooftopSelectionRecord {
	kind: "rooftop-selection"
	stage: typeof GeocodeStageID.RooftopSelection

	/**
	 * The first resolve: the country the databases were chosen for before any place resolved,
	 * and the source that country gave, or null for a resolve without address points.
	 */
	first: { country: string | null; source: AddressPointSource | null }

	/**
	 * The second resolve, or null when the first one answered.
	 *
	 * It runs when the first resolve placed the address in another country and that
	 * country changes one of the resolve's inputs, listed in `changed`.
	 * `source` is the source the second resolve read.
	 *
	 * It is the first resolve's unless `changed` has `address-points`.
	 */
	second: {
		country: string
		source: AddressPointSource | null
		changed: Array<"address-points" | "placetype-map" | "street-country-hints">
	} | null
}

/**
 * A record a stage of the geocode path writes to the request's trace.
 */
export type GeocodeStageRecord = TreeRewriteRecord | DecodeRecord | CountryScopeRecord | RooftopSelectionRecord

/**
 * The context of one geocode request.
 */
export type GeocodeRequestContext = RequestContext<GeocodeStageRecord>

const REGION_RECOGNITION_STAGE = treeRewriteStage(GeocodeStageID.RegionRecognition, recognizeUSRegions)
const BARE_POSTCODE_STAGE = treeRewriteStage(GeocodeStageID.BarePostcode, recognizeBarePostcode)

const STRANDED_AFFIX_STAGE = treeRewriteStage(GeocodeStageID.StrandedAffix, (tree) => {
	repairStrandedAffix(tree)

	return tree
})

/**
 * The four tree rewrites that follow the decode, in the order they run.
 *
 * - A state the decode read as a locality becomes a region with its city under it.
 * - A lone value in an unambiguous postcode format becomes a postcode.
 * - A postcode the query shape recognized replaces the street or house-number reading over the same span.
 * - A street affix with no street joins the place name it abuts.
 *
 * Each writes a `tree-rewrite` record to the trace when it changes the tree.
 */
export function postDecodeRepairStages(
	queryShape: QueryShape
): readonly PipelineStage<AddressTree, AddressTree, TreeRewriteRecord, GeocodeStageID>[] {
	return [
		REGION_RECOGNITION_STAGE,
		BARE_POSTCODE_STAGE,
		treeRewriteStage(GeocodeStageID.PostcodeContradiction, (tree) => {
			repairPostcodeContradiction(tree, queryShape)

			return tree
		}),
		STRANDED_AFFIX_STAGE,
	]
}

/**
 * The record of a country-scope decision.
 */
export function countryScopeRecord(decision: CountryScopeDecision): CountryScopeRecord {
	return { kind: "country-scope", stage: GeocodeStageID.CountryScope, ...decision }
}

/**
 * The stage that decides the country scope of one geocode, through {@linkcode decideCountryScope}.
 *
 * It writes the decision to the trace whenever the request has one, because the
 * decision is the record and costs zero extra work to state.
 */
export function countryScopeStage(
	given: DefaultCountry | null,
	evidence: CountryScopeEvidence
): PipelineStage<AddressTree, CountryScopeDecision, CountryScopeRecord, GeocodeStageID> {
	return {
		id: GeocodeStageID.CountryScope,
		async run(tree, context) {
			const decision = await decideCountryScope(tree, given, evidence)

			context.trace?.(countryScopeRecord(decision))

			return decision
		},
	}
}

/**
 * What {@linkcode rooftopResolveStage} reads beside the parsed tree.
 */
export interface RooftopResolveInputs {
	resolver: Resolver

	/**
	 * The resolve options every other step of the pass has filled.
	 *
	 * The stage sets the address points on them, and for a second resolve the
	 * placetype map and the street country hints.
	 */
	opts: ResolveOpts

	/**
	 * The country the databases are chosen for before any place resolves, lowercase, or null.
	 */
	preResolveCountry: string | null

	/**
	 * The ISO 3166-2 code of the tree's region, such as `US-TX`, or null when the tree states none.
	 */
	regionSubdivision: string | null

	/**
	 * The address points of the tree's region, from the caller's region resolver.
	 */
	regionAddressPoints: AddressPointLookup | null

	/**
	 * The countries the street tier already reads, lowercase.
	 */
	streetHints: readonly string[]
	nationalDatabases?: (country: string) => RegionDatabases
	osmDatabases?: (country: string) => RegionDatabases
}

/**
 * The stage that picks the address-point source, resolves the tree, and resolves it once more
 * when the first resolve placed the address in a country other than the one the sources were picked for.
 *
 * A country's national database outranks its OpenStreetMap one.
 * The region's database outranks both when the region is in the country the sources are
 * picked for, as a state's database is for an address in its own country.
 *
 * A region of another country ranks below both, so a two-letter code two countries share
 * never reads the other country's region in place of the country's own source.
 *
 * Each resolve runs as the `resolve` stage, so this stage's duration includes theirs.
 */
export function rooftopResolveStage(
	inputs: RooftopResolveInputs
): PipelineStage<AddressTree, AddressTree, RooftopSelectionRecord, GeocodeStageID> {
	const { resolver, opts, preResolveCountry, regionAddressPoints, streetHints } = inputs

	// An ISO 3166-2 code opens with its country's ISO 3166-1 code.
	const regionCountry = inputs.regionSubdivision?.slice(0, 2).toLowerCase() ?? null

	const rooftopFor = (country: string | null): { lookup: AddressPointLookup; source: AddressPointSource } | null => {
		if (!country) return null
		const slug = country.toLowerCase()
		const national = inputs.nationalDatabases?.(slug)?.addressPoints

		if (national) return { lookup: national, source: "national" }

		const osm = inputs.osmDatabases?.(slug)?.addressPoints

		return osm ? { lookup: osm, source: "osm" } : null
	}

	// Each resolve reads `opts` as it stands when the stage runs.
	const resolveStage: PipelineStage<AddressTree, AddressTree, never> = {
		id: StageID.Resolve,
		run: (parsed) => resolver.resolveTree(parsed, opts),
	}

	return {
		id: GeocodeStageID.RooftopSelection,
		async run(tree, context) {
			const regionIsHome = regionAddressPoints != null && regionCountry === preResolveCountry
			const rooftop = regionIsHome ? null : rooftopFor(preResolveCountry)
			const addressPoints = rooftop?.lookup ?? regionAddressPoints
			const firstSource: AddressPointSource | null = rooftop?.source ?? (regionAddressPoints ? "region" : null)

			if (addressPoints) {
				opts.addressPoints = addressPoints
				// A register's row can state no locality or postcode, so the search around the resolved locality reaches it.
				opts.addressPointBboxFallback = true
			}

			let resolved = await runStage(resolveStage, tree, context)
			let second: RooftopSelectionRecord["second"] = null

			// The resolved country differs from the one the databases were picked for.
			const scopeCountry = resolvedCountryOf(resolved) ?? postcodeCountryScopeOf(resolved)

			if (scopeCountry && scopeCountry.toLowerCase() !== preResolveCountry && !regionAddressPoints) {
				const scoped = rooftopFor(scopeCountry)
				const changed: NonNullable<RooftopSelectionRecord["second"]>["changed"] = []

				if (scoped) {
					opts.addressPoints = scoped.lookup
					opts.addressPointBboxFallback = true
					changed.push("address-points")
				}

				const scopedMap = placetypeMapForCountry(scopeCountry)

				if (scopedMap !== opts.placetypeMap) {
					opts.placetypeMap = scopedMap
					changed.push("placetype-map")
				}

				if (opts.streetCentroids && !streetHints.includes(scopeCountry.toLowerCase())) {
					opts.streetCountryHints = [scopeCountry.toLowerCase(), ...streetHints]
					changed.push("street-country-hints")
				}

				if (changed.length) {
					resolved = await runStage(resolveStage, tree, context)
					second = { country: scopeCountry, source: scoped?.source ?? firstSource, changed }
				}
			}

			context.trace?.({
				kind: "rooftop-selection",
				stage: GeocodeStageID.RooftopSelection,
				first: { country: preResolveCountry, source: firstSource },
				second,
			})

			return resolved
		},
	}
}
