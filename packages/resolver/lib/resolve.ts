// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * `resolveTree` walks an `AddressTree` top-down and decorates matched nodes.
 *
 * Child lookups are scoped by resolved parents to reduce ambiguity.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { DEFAULT_PLACETYPE_MAP, isPlacetypeFallback } from "@mailwoman/codex/placetype-map"
import { collectNodes, isShapeExcludedPostcode, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import { isPresent } from "@mailwoman/core/objects"
import {
	type DefaultCountry,
	hardCountryOf,
	ScopeStrength,
	type ResolveNodeTrace,
	type ResolvedPlace,
	type ResolveOpts,
	type Resolver,
	type ResolverBackend,
	resolveSwitches,
} from "@mailwoman/core/resolver"
import { countriesFromPostcodeFormat } from "@mailwoman/postcode/postcode-format"

import {
	applyAdminCoherence,
	applyExplicitCountryCoherence,
	applyParentFallbackContradiction,
	applyRegionCountryCoherence,
} from "#admin/coherence-passes"
import { adminContainmentVerdict, firstRegionQualifier, partitionByContainment } from "#admin/containment"
import { COUNTY_DESIGNATOR_FALLBACK, countyFromDesignatedLocality } from "#admin/county-designator"
import { resolveCompoundMunicipality } from "#admin/jp-municipality"
import {
	BARE_REGION_DOMINANCE_LOG10,
	bareCountryCandidate,
	bareRegionCandidate,
	emptyLocalityPick,
	logPopulation,
	loneBareLocalityNode,
} from "#bare-toponym-race"
import { decorateNode } from "#decorate-node"
import {
	findPostcodeCountryScope,
	type PostcodeCountryScope,
	stampPostcodeCountryScope,
} from "#postcode/country-coherence"
import { type CoordinateOptionalPlace, postcodePrefixResolvedPlace, probePostcodePrefix } from "#postcode/prefix"
import { applyPostcodeShapeCoherence } from "#postcode/shape-coherence"
import { applyCountryCode, readRegionCodeAsCountry } from "#resolve/country-code"
import { applyLandmark } from "#resolve/landmark"
import {
	agreesWithParent,
	applyCallerParentQualifier,
	applyParentPlaceCountry,
	readParentPlace,
} from "#resolve/parent-place"
import {
	applyPostcodeConsistency,
	applyRooftopConsistency,
	applySpanRescore,
	createNodeTraceRecorder,
	DIAGNOSTIC_BANDS,
	firstPostcodeValue,
	NOOP_TRACE_RECORDER,
	type NodeTraceRecorder,
	type ResolutionState,
	type ResolvedOpts,
} from "#resolve/passes"
import {
	applyCountryAsRegion,
	applyLocalityAsRegion,
	applyRegionCity,
	applyStreetAsTown,
	applyVenueAsTown,
} from "#resolve/region-city"
import { applySiblingLocalityContainment } from "#resolve/sibling-locality"
import { applyWholeInputPlace } from "#resolve/whole-input"
import {
	placesOutsideCountryScope,
	promoteSoftCountry,
	retrieveWithSoftCountry,
	softScopeRetrieves,
} from "#scope-retrieval"
import { applyAddressPoint, applyInterpolation, applyStreetCentroid } from "#street/tier"
import {
	type CapitalLevelFn,
	DEFAULT_COUNTRY_PRIOR_WEIGHT,
	promoteCapitals,
	rankByCountryPrior,
	rankByImportance,
} from "#toponym-prior"

/**
 * Build a `Resolver` from a `ResolverBackend`.
 */
export { DEFAULT_POSTCODE_MAX_MOVE_KM } from "#resolve/passes"

export function createWOFResolver(backend: ResolverBackend): Resolver {
	return new WOFResolver(backend)
}

/**
 * One lookup's pick: the place, its runners-up, and the metadata the walk stamps on the node.
 */
interface LookupPick {
	top: CoordinateOptionalPlace
	alternatives: ResolvedPlace[]
	metadata?: Record<string, unknown>
}

/**
 * Return an explicit country scope from the tree when it is unambiguous.
 *
 * The tree must contain one country node.
 * Subdivision-like names are ignored.
 */
function explicitCountryScope(roots: readonly AddressNode[]): string | null {
	const countryNodes = collectNodes(roots, (node) => node.tag === "country" && node.value.trim())

	if (countryNodes.length !== 1) return null

	const value = countryNodes[0]!.value.trim()
	const matched = matchCountry(value)

	if (!matched) return null

	if (matchSubdivision(value)) return null

	return matched.iso2
}

/**
 * The default country a lookup filters by, or undefined when none applies.
 * `country` lookups ignore an inferred scope.
 */
function scopedCountryFor(placetype: string, scope: DefaultCountry | null): string | undefined {
	if (!scope || (placetype === "country" && scope.source === "inferred")) return undefined

	return scope.country
}

/**
 * Reports whether the caller chose the default country scope.
 */
function isCallerScope(scope: DefaultCountry | null): boolean {
	return scope?.source === "caller"
}

class WOFResolver implements Resolver {
	readonly #backend: ResolverBackend
	/**
	 * Coverage metadata surfaced from the backend artifact.
	 */
	readonly artifactCoverage: Resolver["artifactCoverage"]

	constructor(backend: ResolverBackend) {
		this.#backend = backend
		this.artifactCoverage = backend.artifactCoverage ?? null
	}

	/**
	 * Direct `findPlace` passthrough.
	 */
	findPlace: Resolver["findPlace"] = (query) => this.#backend.findPlace(query)

	async resolveTree(parsed: AddressTree, callerOpts: ResolveOpts = {}): Promise<AddressTree> {
		const tree = readRegionCodeAsCountry(parsed)

		// Every on/off switch resolves against the one defaults table, so the reads below are plain truthiness.
		const opts: ResolvedOpts = { ...callerOpts, ...resolveSwitches(callerOpts) }

		// Optional early postcode-shape pass.
		// Runs sync and can only narrow candidates.
		const shapeVerdict = opts.postcodeShapeCoherence ? applyPostcodeShapeCoherence(tree.roots) : null

		const state: ResolutionState = {
			lookupsRemaining: opts.maxLookups ?? 10,
			// If provided, `placetypeMap` fully replaces the default.
			placetypeMap: opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP,
			minWinningScore: opts.minWinningScore ?? 0,
			minScoreRefusals: 0,
			candidatesPerLookup: opts.candidatesPerLookup ?? 5,
			// One scope value: a hard scope filters, and a soft one ranks.
			defaultCountry: hardCountryOf(opts.defaultCountry) ? opts.defaultCountry! : null,
			softCountry: opts.defaultCountry?.strength === ScopeStrength.Soft ? opts.defaultCountry : null,
			softCountryWeight: opts.softCountryWeight ?? DEFAULT_COUNTRY_PRIOR_WEIGHT,
			scopeCountryRetrieval: opts.scopeCountryRetrieval,
			parentPlace: opts.parentPlace ? readParentPlace(this.#backend, opts.parentPlace) : null,
			bareLocalityNode: loneBareLocalityNode(tree, opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP),
			parentFallback: opts.parentFallback,
			// Only enable unreachable diagnostics when a trace sink exists.
			...(opts.diagnoseUnreachable && opts.traceSink ? { diagnoseUnreachable: true } : {}),
			postcode: firstPostcodeValue(tree.roots),
			// Optional postcode-containment hint for locality lookups.
			postcodeContainmentCoherence: opts.postcodeContainmentCoherence,
			// Optional postcode-prefix prior and index.
			postcodePrefixPrior: opts.postcodePrefixPrior,
			postcodePrefixIndex: opts.postcodePrefixIndex,
			// Derive format-implied countries when not provided.
			postcodeFormatCountries:
				opts.postcodeFormatCountries ?? countriesFromPostcodeFormat(firstPostcodeValue(tree.roots)),
			fuzzyCountryScope: opts.fuzzyCountryScope,
			bias: opts.bias,
			anchorPosterior: opts.anchorPosterior,
			anchorWeight: opts.anchorWeight ?? 2,
			capitalLevel: opts.capitalLevel,
			hardCountry: opts.hardCountry,
			includeAncestors: opts.includeAncestors,
			// Optional admin containment rerank uses a pre-scanned region qualifier.
			adminContainmentRerank: opts.adminContainmentRerank,
			dependentLocalityContainment: opts.dependentLocalityContainment,
			countyDesignatorFallback: opts.countyDesignatorFallback,
			regionQualifier: firstRegionQualifier(tree.roots),
			...(opts.traceSink ? { traceSink: opts.traceSink } : {}),
		}

		applyParentPlaceCountry(state)

		// Optional pre-walk postcode-country coherence pass.
		// This is the only pass allowed to override `defaultCountry`.
		let postcodeScope: PostcodeCountryScope | null = null

		// Explicit country text in the tree can pre-scope the walk.
		// Explicit scope outranks inferred default scope.
		let explicitScope: string | null = null

		if (state.defaultCountry?.source !== "caller") {
			explicitScope = explicitCountryScope(tree.roots)

			if (explicitScope) {
				state.defaultCountry = { country: explicitScope, source: "caller" }
			}
		}

		if (opts.postcodeCountryCoherence && state.postcode) {
			postcodeScope = await findPostcodeCountryScope(tree.roots, this.#backend, {
				postcode: state.postcode,
				defaultCountry: state.defaultCountry?.country ?? null,
				...(shapeVerdict?.narrowing ? { candidateSystems: shapeVerdict.narrowing } : {}),
				...(opts.postcodeCountryCoherenceThresholdKm != null
					? { thresholdKm: opts.postcodeCountryCoherenceThresholdKm }
					: {}),
			})

			if (postcodeScope) {
				// Override default country for the walk.
				// The postcode's country replaces the scope but keeps its source.
				state.defaultCountry = { country: postcodeScope.country, source: state.defaultCountry?.source ?? "caller" }
			}
		}

		const newRoots: AddressNode[] = []

		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}

		// A later pass that gives one of these nodes a different place removes the walk's ancestors with the old place.
		const walkedWithAncestors = collectNodes(newRoots, (n) => n.metadata?.["ancestors"] != null)

		if (opts.siblingLocalityContainment) {
			await applySiblingLocalityContainment(newRoots, this.#backend, {
				placetype: state.placetypeMap.locality ?? "locality",
				limit: state.candidatesPerLookup,
				traceSink: state.traceSink ?? null,
			})
		}

		// Stamp metadata for postcode-country override.
		if (postcodeScope) {
			stampPostcodeCountryScope(newRoots, postcodeScope)
		}

		// Stamp metadata when explicit country pre-scope was used.
		if (explicitScope) {
			for (const root of newRoots) {
				if (root.tag === "country") {
					root.metadata = { ...root.metadata, explicit_country_scope: explicitScope }
				}
			}
		}

		// Admin coherence passes (default on).
		if (opts.adminCoherence) {
			// Clear contradictory parent-fallback picks before coherence passes.
			applyParentFallbackContradiction(newRoots)
			await applyAdminCoherence(newRoots, this.#backend)
			// Re-resolve locality when explicit country contradicts it.
			await applyExplicitCountryCoherence(newRoots, this.#backend)
			// Re-resolve foreign region/locality pairs blocked by locale scope.
			await applyRegionCountryCoherence(newRoots, this.#backend, state.defaultCountry?.country ?? null)
			await applyRegionCity(newRoots, this.#backend)
			await applyCountryAsRegion(newRoots, this.#backend)
			await applyVenueAsTown(newRoots, this.#backend)
			await applyStreetAsTown(newRoots, this.#backend)

			if (isCallerScope(state.defaultCountry)) {
				await applyLocalityAsRegion(newRoots, this.#backend, state.defaultCountry!.country)
			}

			await applyCountryCode(newRoots, opts.writtenInput ?? tree.raw, this.#backend)
		}

		if (opts.landmarks) {
			await applyLandmark(newRoots, opts.writtenInput ?? tree.raw, opts.landmarks)
		}

		if (opts.adminCoherence) {
			await applyWholeInputPlace(
				newRoots,
				opts.writtenInput ?? tree.raw,
				this.#backend,
				isCallerScope(state.defaultCountry) ? state.defaultCountry!.country : null
			)
		}

		// The postcode and rooftop passes hold a locality to the same distance from their point.
		const consistencyThresholdKm = opts.postcodeConsistencyThresholdKm ?? 50

		// Postcode/locality consistency pass (default on).
		if (opts.postcodeConsistency) {
			await applyPostcodeConsistency(newRoots, consistencyThresholdKm, opts.postcodeConsistencyMaxMoveKm)
		}

		// A register can key a borough's or neighborhood's addresses to an ancestor's name,
		// so a miss retries the ancestors.
		const ancestorsOf = this.#backend.ancestors?.bind(this.#backend)

		// Optional exact address-point tier.
		if (opts.addressPoints) {
			await applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback, ancestorsOf)
		}

		// Optional interpolation tier after exact points.
		if (opts.interpolation) {
			applyInterpolation(newRoots, opts.interpolation, opts.interpolationRadiusCalibration)
		}

		// Span-rescore fallback tier (default on).
		// Skip when a min-score refusal already occurred.
		if (opts.spanRescore && state.minScoreRefusals === 0) {
			await applySpanRescore(
				newRoots,
				tree.raw,
				this.#backend,
				// A hard parent's country filters the probes as a caller's default country does.
				state.parentPlace && state.defaultCountry ? { ...opts, defaultCountry: state.defaultCountry } : opts,
				!state.defaultCountry && softScopeRetrieves(state) ? state.softCountry!.country : null
			)
		}

		// OpenStreetMap places answer after span rescore, so a town that holds the whole name keeps it.
		if (opts.osmPlaces) {
			await applyLandmark(newRoots, opts.writtenInput ?? tree.raw, opts.osmPlaces)
		}

		// Retry exact address-point tier once after span-rescore recovery.
		if (opts.addressPoints) {
			await applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback, ancestorsOf)
		}

		// A rooftop row keyed by locality name can lie in a namesake of the selected locality.
		if (opts.addressPoints && opts.postcodeConsistency) {
			await applyRooftopConsistency(newRoots, consistencyThresholdKm, this.#backend)
		}

		// Optional street-centroid tier runs last.
		if (opts.streetCentroids) {
			applyStreetCentroid(newRoots, tree.raw, opts.streetCentroids, opts.streetCountryHints ?? [])
		}

		// The walk's ancestors are read again for the place that replaced its pick.
		if (this.#backend.ancestors) {
			for (const node of walkedWithAncestors) {
				const id = node.placeID?.startsWith("wof:") ? Number(node.placeID.slice(4)) : Number.NaN

				if (node.metadata?.["ancestors"] == null && Number.isInteger(id)) {
					node.metadata = { ...node.metadata, ancestors: this.#backend.ancestors(id) }
				}
			}
		}

		return { raw: tree.raw, roots: newRoots }
	}

	async #walk(
		node: AddressNode,
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState
	): Promise<AddressNode> {
		// Clone.
		// The caller's nodes stay as they were passed in.
		const decorated: AddressNode = { ...node, children: [] }

		const placetype = state.placetypeMap[node.tag as ComponentTag]

		let resolved: CoordinateOptionalPlace | null = null

		// Skip lookup for shape-excluded postcode spans.
		if (placetype && state.lookupsRemaining > 0 && node.value.trim() && !isShapeExcludedPostcode(node)) {
			let picked = await this.#lookupAndPick(node, placetype, parentResolved, state)

			// Compound JP municipality handling with scoped fallback control.
			if (!picked && node.tag === "municipality") {
				picked = await resolveCompoundMunicipality(
					node.value,
					parentResolved,
					() => state.lookupsRemaining > 0,
					async (value, scope, parentFallback) => {
						const prior = state.parentFallback
						state.parentFallback = prior && parentFallback

						try {
							return await this.#lookupAndPick({ ...node, value }, placetype, scope, state)
						} finally {
							state.parentFallback = prior
						}
					}
				)
			}

			if (picked) {
				resolved = picked.top
				decorateNode(decorated, picked.top, picked.alternatives, picked.considered)

				if (picked.metadata) {
					decorated.metadata = { ...decorated.metadata, ...picked.metadata }
				}

				// Retag bare-toponym repicks to the resolved admin type.
				if (decorated.metadata?.["bare_country_repick"]) {
					decorated.tag = "country"
				} else if (decorated.metadata?.["bare_region_repick"]) {
					decorated.tag = "region"
				} else if (decorated.metadata?.[COUNTY_DESIGNATOR_FALLBACK]) {
					decorated.tag = "subregion"
				}

				// Optional lineage attachment.
				if (state.includeAncestors && this.#backend.ancestors) {
					decorated.metadata = { ...decorated.metadata, ancestors: this.#backend.ancestors(picked.top.id) }
				}
			}
		}

		const carryParent = resolved ?? parentResolved

		for (const child of node.children) {
			decorated.children.push(await this.#walk(child, carryParent, state))
		}

		return decorated
	}

	/**
	 * Find other admin bands that match the same value.
	 * Keeps country scope and clears parent scope.
	 */
	async #probeOtherBands(
		query: Parameters<ResolverBackend["findPlace"]>[0],
		probed: string
	): Promise<NonNullable<ResolveNodeTrace["reachableIn"]>> {
		const found: NonNullable<ResolveNodeTrace["reachableIn"]> = []

		for (const band of DIAGNOSTIC_BANDS) {
			if (band === probed) continue

			try {
				const hits = await this.#backend.findPlace({
					...query,
					placetype: band,
					parentID: undefined,
					parentQualifierID: undefined,
				})

				if (hits.length) {
					found.push({ placetype: band, n: hits.length })
				}
			} catch {
				// Skip bands the backend cannot query.
				continue
			}
		}

		return found
	}

	/**
	 * A soft scope's own rows merged into an unscoped lookup's candidates, under scope retrieval.
	 *
	 * It returns `candidates` unchanged without a soft country, when the lookup already
	 * has a country, or when the soft scope ranks only.
	 */
	async #withSoftCountryRows(
		query: Parameters<ResolverBackend["findPlace"]>[0],
		candidates: ResolvedPlace[],
		softCountry: string | null,
		state: ResolutionState,
		rec: NodeTraceRecorder
	): Promise<ResolvedPlace[]> {
		if (!softCountry || query.country || !softScopeRetrieves(state)) return candidates

		rec.check("soft_country_retrieval")
		const merged = await retrieveWithSoftCountry(this.#backend, query, candidates, softCountry)

		rec.stage("soft_country", merged)

		return merged
	}

	/**
	 * A hard caller parent's split of the ranked candidates into those its lineage agrees with
	 * and the excluded rest, each marked `outsideScope`.
	 *
	 * Without a hard parent or an ancestors lookup, every candidate is kept.
	 */
	#applyHardParent(
		ranked: ResolvedPlace[],
		qualifierIsParent: boolean,
		state: ResolutionState,
		rec: NodeTraceRecorder
	): { kept: ResolvedPlace[]; excluded: ResolvedPlace[] } {
		const parent = state.parentPlace

		if (parent?.scope.strength !== ScopeStrength.Hard || !this.#backend.ancestors) return { kept: ranked, excluded: [] }

		const ancestors = this.#backend.ancestors.bind(this.#backend)
		const agrees = (c: ResolvedPlace) => agreesWithParent(c, parent, ancestors, qualifierIsParent)
		const kept = ranked.filter(agrees)

		rec.stage("parent_scope", kept)

		return {
			kept,
			excluded: ranked.filter((c) => !agrees(c)).map((c) => ({ ...c, outsideScope: true as const })),
		}
	}

	/**
	 * The same-name places outside a hard default country, for the node's
	 * `considered` list, under scope retrieval.
	 *
	 * The probe changes no pick, so a backend error is traced and answers no places.
	 */
	async #placesOutsideScope(
		query: Parameters<ResolverBackend["findPlace"]>[0],
		state: ResolutionState,
		rec: NodeTraceRecorder
	): Promise<ResolvedPlace[]> {
		if (!state.scopeCountryRetrieval || !query.country) return []

		try {
			const outside = await placesOutsideCountryScope(this.#backend, query, query.country)

			rec.check(`outside_scope: ${outside.length}`)

			return outside
		} catch (error) {
			rec.check(`outside_scope_error: ${(error as Error).message}`)

			return []
		}
	}

	/**
	 * The county of a designated `locality` value's name in its region, when the locality
	 * lookup found no locality known to be inside that region.
	 *
	 * A candidate is known inside when the lookup was scoped by the region and kept it,
	 * or when the qualifier containment partition marked it contained.
	 * A candidate whose containment neither the region scope nor the partition
	 * computed keeps the locality pick.
	 *
	 * A `locality` lookup is region-scoped exactly when its resolved parent has
	 * a numeric id (`applyParentScope`).
	 */
	async #countyDesignatorPick(
		node: AddressNode,
		placetype: string,
		country: string | undefined,
		candidates: readonly ResolvedPlace[],
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState,
		rec: NodeTraceRecorder
	): Promise<LookupPick | null> {
		if (!state.countyDesignatorFallback || placetype !== "locality" || node.tag !== "locality" || !country) return null

		const regionScoped = typeof parentResolved?.id === "number"

		const inRegion = candidates.some(
			(c) => c.containedByQualifier === true || (regionScoped && c.regionScopeMiss !== true)
		)

		const unplaced = candidates.some((c) => c.containedByQualifier == null && !regionScoped)

		if (inRegion || unplaced) return null

		const parentIsRegion = parentResolved?.placetype === "region" || parentResolved?.placetype === "macroregion"

		const county = await countyFromDesignatedLocality(this.#backend, node.value, {
			country,
			regionID: parentIsRegion && typeof parentResolved.id === "number" ? parentResolved.id : null,
			regionQualifier: state.regionQualifier ?? null,
			limit: state.candidatesPerLookup,
		})

		if (!county) return null

		rec.check(COUNTY_DESIGNATOR_FALLBACK)
		rec.emit({ id: county.top.id, name: county.top.name, source: COUNTY_DESIGNATOR_FALLBACK })

		return { ...county, metadata: { [COUNTY_DESIGNATOR_FALLBACK]: true } }
	}

	/**
	 * The postcode-prefix prior's pick for a `postalcode` lookup that missed,
	 * when the prior is on and the prefix index holds the code's prefix.
	 */
	#postcodePrefixPick(
		node: AddressNode,
		placetype: string,
		country: string | undefined,
		candidates: readonly ResolvedPlace[],
		state: ResolutionState,
		rec: NodeTraceRecorder
	): LookupPick | null {
		if (candidates.length || placetype !== "postalcode" || !state.postcodePrefixPrior || !state.postcodePrefixIndex) {
			return null
		}

		const probe = probePostcodePrefix(node.value, state.postcodePrefixIndex, country)

		if (!probe) return null

		const metadata: Record<string, unknown> = {
			postcode_prefix: probe.prefix,
			postcode_prefix_ancestors: probe.node.ancestors,
			...(probe.node.radiusP95Km != null ? { postcode_prefix_radius_p95_km: probe.node.radiusP95Km } : {}),
			...(probe.node.lat != null && probe.node.lon != null ? { coordinate_source: "postcode_prefix" } : {}),
		}

		rec.check("postcode_prefix_prior")
		const prefixPlace = postcodePrefixResolvedPlace(probe.prefix, probe.node, state.postcodePrefixIndex)

		rec.emit({ id: prefixPlace.id, name: prefixPlace.name, source: "postcode_prefix" })

		return { top: prefixPlace, alternatives: [], metadata }
	}

	async #lookupAndPick(
		node: AddressNode,
		placetype: string,
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState
	): Promise<{
		top: CoordinateOptionalPlace
		alternatives: ResolvedPlace[]
		/**
		 * The probe winners the pick passed over.
		 * Only the geocode result's candidate list reads them.
		 */
		considered?: ResolvedPlace[]
		metadata?: Record<string, unknown>
	} | null> {
		state.lookupsRemaining--

		const query: Parameters<ResolverBackend["findPlace"]>[0] = {
			text: node.value,
			placetype,
			limit: state.candidatesPerLookup,
		}

		// Optional proximity bias reorders candidates without changing the candidate set.
		if (state.bias && state.bias.length) {
			query.bias = state.bias
		}

		const parentContainment = applyParentScope(query, node, parentResolved, state)

		const callerParentQualifies = applyCallerParentQualifier(query, state)

		// Country scope precedence: parent -> default -> node hint -> hard country.
		const countryHint = node.metadata?.["country_hint"]

		// Do not apply inferred default-country filtering to country lookups.
		const defaultCountryForLookup = scopedCountryFor(placetype, state.defaultCountry)

		const country =
			parentResolved?.country ??
			defaultCountryForLookup ??
			(typeof countryHint === "string" ? countryHint : null) ??
			state.hardCountry

		if (country) {
			query.country = country
		}

		// Optional fuzzy-country hint for typo-fuzzy backend logic.
		if (state.fuzzyCountryScope) {
			query.fuzzyCountry = state.fuzzyCountryScope
		}

		// Optional containment rerank for locality using region qualifier.
		const containmentEligible =
			state.adminContainmentRerank &&
			placetype === "locality" &&
			state.regionQualifier != null &&
			!isCallerScope(state.defaultCountry) &&
			// The backend reads one qualifier, and the caller's parent outranks the parsed region.
			!state.parentPlace

		if (containmentEligible) {
			query.regionQualifier = state.regionQualifier!
		}

		// Optional locality postcode hint and containment coherence flag.
		if (placetype === "locality" && state.postcode) {
			query.postcode = state.postcode

			if (state.postcodeContainmentCoherence) {
				query.postcodeContainmentCoherence = true
			}
		}

		// Trace recorder (no-op when no sink).
		const rec = state.traceSink ? createNodeTraceRecorder(state.traceSink) : NOOP_TRACE_RECORDER

		// Bind a snapshot so later query mutations do not affect trace history.
		rec.bind(node, placetype, { ...query }, state.candidatesPerLookup)

		let candidates: ResolvedPlace[]

		// The anchor posterior and both country scopes act on region and locality lookups only.
		const anchorEligible = placetype === "region" || placetype === "locality"

		// A soft scope ranks a lookup no hard country, tree parent or anchor posterior already scopes.
		const softCountry =
			anchorEligible && !state.defaultCountry && !state.anchorPosterior ? (state.softCountry?.country ?? null) : null

		// The places a hard scope excluded, reported on `considered`.
		let outsideScope: ResolvedPlace[] = []

		// For unconstrained postalcodes, probe format-implied countries only.
		if (placetype === "postalcode" && !query.country && state.postcodeFormatCountries?.length) {
			rec.check("postcode_format_probe")
			let best: ResolvedPlace | null = null
			const countryWinners: ResolvedPlace[] = []

			for (const impliedCountry of state.postcodeFormatCountries) {
				try {
					const hits = await this.#backend.findPlace({ ...query, country: impliedCountry })
					const top = hits[0]

					if (top) {
						countryWinners.push(top)
					}

					// Keep the best per-country winner by score.
					if (top && (!best || top.score > best.score)) {
						best = top
					}
				} catch {
					// Treat per-country probe errors as misses.
				}
			}

			if (best) {
				rec.emit({ id: best.id, name: best.name, source: "postcode_format_probe" })

				return { top: best, alternatives: [], considered: countryWinners.filter((c) => c !== best) }
			}

			candidates = []
		} else {
			try {
				candidates = await this.#backend.findPlace(query)
				rec.stage("initial", candidates)

				// Surface backend region-scope fallback as a trace check.
				if (candidates[0]?.regionScopeMiss) {
					rec.check("region_scope_miss")
				}

				// If parent scope misses, retry once without parent scope.
				if (!candidates.length && state.parentFallback && query.parentID != null) {
					delete query.parentID
					rec.check("parent_fallback_retry")
					candidates = await this.#backend.findPlace(query)
					rec.stage("parent_fallback", candidates)
				}

				candidates = await this.#withSoftCountryRows(query, candidates, softCountry, state, rec)

				// Only a lookup the default country filtered reports the same-name places outside it.
				const filteredByDefault =
					anchorEligible && !parentResolved && query.country != null && query.country === defaultCountryForLookup

				outsideScope = filteredByDefault ? await this.#placesOutsideScope(query, state, rec) : []

				// Optional diagnostics: record other bands that can resolve this value.
				if (!candidates.length && state.diagnoseUnreachable) {
					rec.reachable(await this.#probeOtherBands(query, placetype))
				}
			} catch (error) {
				// Defensive: backend errors shouldn't abort the whole tree walk.
				rec.check(`backend_error: ${(error as Error).message}`)
				rec.emit(null)

				return null
			}
		}

		// A designated county span resolves as its region's county, and a missed postcode takes the prefix prior.
		const recovered =
			(await this.#countyDesignatorPick(node, placetype, query.country, candidates, parentResolved, state, rec)) ??
			this.#postcodePrefixPick(node, placetype, query.country, candidates, state, rec)

		if (recovered) return recovered

		// Bare-toponym race: locality-tagged single spans also probe country/region.
		const isBareRace = placetype === "locality" && node === state.bareLocalityNode

		if (isBareRace) {
			rec.check("bare_race")
		}

		const bareCountry = isBareRace ? await bareCountryCandidate(this.#backend, node.value, query.country) : null
		const bareRegion = isBareRace ? await bareRegionCandidate(this.#backend, node.value, query.country) : null

		// The race probes a pick passes over, kept for the geocode result's candidate list.
		const raceLosers = (picked: ResolvedPlace | null): ResolvedPlace[] =>
			[bareCountry, bareRegion].filter(isPresent).filter((probe) => probe !== picked)

		if (!candidates.length) {
			// With no locality candidates, a bare name takes an admin or sub-locality namesake.
			const pick = isBareRace
				? await emptyLocalityPick(this.#backend, node.value, query.country, bareCountry, bareRegion)
				: null

			if (pick) {
				rec.check(pick.check)
				rec.emit({ id: pick.place.id, name: pick.place.name, source: pick.source })

				return {
					top: pick.place,
					alternatives: [],
					considered: [...raceLosers(pick.place), ...outsideScope],
					metadata: pick.metadata,
				}
			}

			rec.emit(null)

			return null
		}

		const softPromotion = rankByPriors(candidates, anchorEligible, softCountry, node, state, rec)
		let ranked = softPromotion.ranked

		// Final containment partition.
		// It reads the address's own qualifier and preserves the exact-match tier.
		const qualifierPartition = containmentEligible || parentContainment || callerParentQualifies

		if (qualifierPartition) {
			ranked = partitionByContainment(
				ranked,
				(c) => c.containedByQualifier === true,
				(c) => c.exactMatch === true
			)

			rec.stage("containment", ranked)
		}

		// Prefer exact requested placetype over macro fallback.
		const hasFallbackCandidate = ranked.some((c) => isPlacetypeFallback(placetype, c.placetype))

		if (hasFallbackCandidate && ranked.length > 1) {
			ranked = [
				...ranked.filter((c) => !isPlacetypeFallback(placetype, c.placetype)),
				...ranked.filter((c) => isPlacetypeFallback(placetype, c.placetype)),
			]

			rec.stage("exact_type", ranked)
		}

		const parentScoped = this.#applyHardParent(ranked, callerParentQualifies, state, rec)

		ranked = parentScoped.kept
		outsideScope = [...parentScoped.excluded, ...outsideScope]

		if (!ranked.length) {
			rec.check("parent_scope_excluded_all")
			rec.emit(null)

			return null
		}

		const top = ranked[0]!

		if (top.score < state.minWinningScore) {
			state.minScoreRefusals++
			rec.check("min_score_reject")
			rec.emit(null)

			return null
		}

		// Bare-toponym admin repick rules.
		if (bareCountry && (bareCountry.prominence ?? bareCountry.score) > (top.prominence ?? top.score)) {
			rec.check("bare_country_repick")
			rec.emit({ id: bareCountry.id, name: bareCountry.name, source: "bare_country" })

			return {
				top: bareCountry,
				alternatives: ranked,
				considered: [...raceLosers(bareCountry), ...outsideScope],
				metadata: { bare_country_repick: true },
			}
		}

		if (bareRegion && logPopulation(bareRegion) >= logPopulation(top) + BARE_REGION_DOMINANCE_LOG10) {
			rec.check("bare_region_repick")
			rec.emit({ id: bareRegion.id, name: bareRegion.name, source: "bare_region" })

			return {
				top: bareRegion,
				alternatives: ranked,
				considered: [...raceLosers(bareRegion), ...outsideScope],
				metadata: { bare_region_repick: true },
			}
		}

		// Stamp fallback quality when a macro-type winner stands in.
		if (isPlacetypeFallback(placetype, top.placetype)) {
			top.resolutionQuality = "fallback"
			rec.check("placetype_fallback")
		}

		rec.emit({ id: top.id, name: top.name, source: "ranked" })

		// Trace receipts for mechanism-level observability.
		const pickMetadata = {
			...containmentStamps(qualifierPartition, parentContainment, ranked, top),
			...(top.variantAliasExempted === true ? { variant_alias_exemption: true } : {}),
			// The soft scope's promotion moved this place ahead of a larger namesake.
			...(top === softPromotion.promoted ? { soft_country_promotion: softCountry } : {}),
			// Mark picks admitted outside resolved parent scope.
			...((parentResolved && typeof parentResolved.id === "number" && query.parentID == null) ||
			top.regionScopeMiss === true
				? { parent_fallback: true }
				: {}),
		}

		return {
			top,
			alternatives: ranked.slice(1),
			considered: [...raceLosers(null), ...outsideScope],
			...(Object.keys(pickMetadata).length ? { metadata: pickMetadata } : {}),
		}
	}
}

/**
 * Scopes a lookup to its resolved parent and reports whether the parent is a containment qualifier.
 *
 * A parent is a `parentID` region scope.
 * A `dependent_locality` node under the `dependentLocalityContainment` switch passes
 * its parent as `parentQualifierID` instead (#2804).
 *
 * The candidate table's region scope holds region ids, so a locality parent never satisfies it.
 *
 * The containment partition admits the sub-locality rows the locality band excludes.
 */
function applyParentScope(
	query: Parameters<ResolverBackend["findPlace"]>[0],
	node: AddressNode,
	parentResolved: CoordinateOptionalPlace | null,
	state: ResolutionState
): boolean {
	if (!parentResolved || typeof parentResolved.id !== "number") return false

	if (state.dependentLocalityContainment && node.tag === "dependent_locality") {
		query.parentQualifierID = parentResolved.id

		return true
	}

	query.parentID = parentResolved.id

	return false
}

/**
 * The pick metadata a containment partition writes: the tri-state verdict when a qualifier was
 * read, and `contained_by_parent` when a dependent locality's pick sits inside its parent.
 *
 * The geocode result's admin ladder reads the second stamp to let the pick answer ahead of the locality.
 */
function containmentStamps(
	qualifierPartition: boolean,
	parentContainment: boolean,
	ranked: readonly ResolvedPlace[],
	top: ResolvedPlace
): Record<string, unknown> {
	if (!qualifierPartition) return {}

	return {
		admin_containment: adminContainmentVerdict(ranked),
		...(parentContainment && top.containedByQualifier === true ? { contained_by_parent: true } : {}),
	}
}

/**
 * Ranks a lookup's candidates by its priors in order: the postcode anchor posterior,
 * the ranking-only soft scope, importance with capital promotion, then the retrieval soft scope.
 *
 * `promoted` is the place the retrieval soft scope moved to the lead, or null.
 */
function rankByPriors(
	candidates: ResolvedPlace[],
	anchorEligible: boolean,
	softCountry: string | null,
	node: AddressNode,
	state: ResolutionState,
	rec: NodeTraceRecorder
): { ranked: ResolvedPlace[]; promoted: ResolvedPlace | null } {
	let ranked = candidates

	// Optional anchor-based rerank using postcode country posterior, kept tier-safe by exact-match first.
	if (state.anchorPosterior && anchorEligible && candidates.length > 1) {
		ranked = rankByAnchorPosterior(candidates, state.anchorPosterior, state.anchorWeight)
		rec.stage("anchor", ranked)
		ranked = rankWithinPosteriorCountry(ranked, state.capitalLevel, node)
		rec.stage("importance", ranked)
	}

	// Without scope retrieval, the soft scope adds to candidate scores ahead of the importance rerank.
	if (softCountry && !softScopeRetrieves(state)) {
		ranked = rankByCountryPrior(ranked, softCountry, state.softCountryWeight)
		rec.stage("locale_prior", ranked)
	}

	// Importance-first rerank (the posterior branch above runs its own, within the winning country).
	if (!state.anchorPosterior) {
		ranked = rankByImportance(ranked)
		rec.stage("importance", ranked)

		// Optional bounded capital promotion.
		if (state.capitalLevel) {
			ranked = promoteCapitalsWithReceipt(ranked, state.capitalLevel, node)
			rec.stage("capital", ranked)
		}
	}

	return promoteSoftCountry(ranked, softCountry, state, rec)
}

/**
 * Sorts candidates by the postcode country posterior, exact matches first.
 *
 * Within a match tier, the key is a candidate's prominence (its score when it has none)
 * plus `weight` times its country's posterior mass.
 * A candidate with no country gets no posterior mass.
 */
function rankByAnchorPosterior<
	T extends Pick<ResolvedPlace, "score" | "country"> & Partial<Pick<ResolvedPlace, "exactMatch" | "prominence">>,
>(candidates: readonly T[], posterior: Readonly<Record<string, number>>, weight: number): T[] {
	const key = (c: T) => (c.prominence ?? c.score) + weight * (c.country ? (posterior[c.country] ?? 0) : 0)

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
	return [...candidates].sort(
		(a, b) => Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false) || key(b) - key(a) || b.score - a.score
	)
}

/**
 * Reorders the posterior-ranked leader's peers, the candidates in its country and exact-match
 * tier, by importance and capital promotion, as the path without a posterior ranks them.
 *
 * The posterior decides the country.
 * Within that country this order makes a venue query (`Clayton Post Office, Clayton, WI`)
 * pick the same locality as its bare form (`Clayton, WI`).
 */
function rankWithinPosteriorCountry<
	T extends Pick<ResolvedPlace, "score" | "name" | "country" | "lat" | "lon"> &
		Partial<Pick<ResolvedPlace, "exactMatch" | "importance" | "prominence">>,
>(
	ranked: readonly T[],
	capitalLevel: CapitalLevelFn | null | undefined,
	node: { metadata?: Record<string, unknown> | null }
): T[] {
	const leader = ranked[0]

	if (!leader?.country) return [...ranked]

	const isPeer = (c: T) => c.country === leader.country && (c.exactMatch === true) === (leader.exactMatch === true)
	let peers = rankByImportance(ranked.filter(isPeer))

	if (capitalLevel) {
		peers = promoteCapitalsWithReceipt(peers, capitalLevel, node)
	}

	return [...peers, ...ranked.filter((c) => !isPeer(c))]
}

/**
 * Promote capitals and stamp `capital_promotion` when the leader changes.
 * Metadata only.
 */
function promoteCapitalsWithReceipt<
	T extends Pick<ResolvedPlace, "score" | "name" | "country" | "lat" | "lon"> &
		Partial<Pick<ResolvedPlace, "exactMatch" | "importance" | "prominence">>,
>(ranked: readonly T[], level: CapitalLevelFn, node: { metadata?: Record<string, unknown> | null }): T[] {
	const promoted = promoteCapitals(ranked, level)

	if (promoted[0] !== ranked[0]) {
		node.metadata = { ...node.metadata, capital_promotion: promoted[0]!.country ?? true }
	}

	return promoted
}
