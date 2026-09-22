/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `resolveTree` walks an `AddressTree` top-down and decorates matched nodes.
 * Child lookups are scoped by resolved parents to reduce ambiguity.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import { DEFAULT_PLACETYPE_MAP, isPlacetypeFallback } from "@mailwoman/codex/placetype-map"
import { collectNodes, type AddressNode, type AddressTree, type Interpretation } from "@mailwoman/core/decoder"
import {
	type BackendCapabilityGap,
	type ResolveNodeTrace,
	type ResolvedPlace,
	type ResolveOpts,
	type Resolver,
	type ResolverBackend,
	countriesFromPostcodeFormat,
} from "@mailwoman/core/resolver"

import {
	applyAdminCoherence,
	applyExplicitCountryCoherence,
	applyParentFallbackContradiction,
	applyRegionCountryCoherence,
} from "#admin/coherence-passes"
import { adminContainmentVerdict, firstRegionQualifier, partitionByContainment } from "#admin/containment"
import { resolveCompoundMunicipality } from "#admin/jp-municipality"
import { describeCapabilityGaps, reportCapabilityGaps } from "#backend-capabilities"
import {
	BARE_REGION_DOMINANCE_LOG10,
	bareCountryCandidate,
	bareRegionCandidate,
	logPopulation,
	loneBareLocalityNode,
	pickLargerAdmin,
} from "#bare-toponym-race"
import { decorateNode } from "#decorate-node"
import {
	findPostcodeCountryScope,
	type PostcodeCountryScope,
	stampPostcodeCountryScope,
} from "#postcode/country-coherence"
import { type CoordinateOptionalPlace, postcodePrefixResolvedPlace, probePostcodePrefix } from "#postcode/prefix"
import { applyPostcodeShapeCoherence, isShapeExcludedPostcode } from "#postcode/shape-coherence"
import {
	applyPostcodeConsistency,
	applySpanRescore,
	createNodeTraceRecorder,
	DIAGNOSTIC_BANDS,
	firstPostcodeValue,
	NOOP_TRACE_RECORDER,
	pickCompletion,
	type ResolutionState,
} from "#resolve/passes"
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
 * Return an explicit country scope from the tree when it is unambiguous.
 *
 * Only one country node is allowed, and subdivision-like names are ignored.
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

class WOFResolver implements Resolver {
	readonly #backend: ResolverBackend
	/**
	 * Coverage metadata surfaced from the backend artifact.
	 */
	readonly artifactCoverage: Resolver["artifactCoverage"]
	/**
	 * Missing optional backend capabilities.
	 */
	readonly capabilityGaps: readonly BackendCapabilityGap[]

	constructor(backend: ResolverBackend) {
		this.#backend = backend
		this.artifactCoverage = backend.artifactCoverage
		this.capabilityGaps = describeCapabilityGaps(backend)
		reportCapabilityGaps(this.capabilityGaps)
	}

	/**
	 * Direct `findPlace` passthrough.
	 */
	findPlace: Resolver["findPlace"] = (query) => this.#backend.findPlace(query)

	async resolveTree(tree: AddressTree, opts: ResolveOpts = {}): Promise<AddressTree> {
		// Optional early postcode-shape pass.
		// Runs sync and can only narrow candidates.
		const shapeVerdict = opts.postcodeShapeCoherence === true ? applyPostcodeShapeCoherence(tree.roots) : null

		const state: ResolutionState = {
			lookupsRemaining: opts.maxLookups ?? 10,
			// If provided, `placetypeMap` fully replaces the default.
			placetypeMap: opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP,
			minWinningScore: opts.minWinningScore ?? 0,
			minScoreRefusals: 0,
			candidatesPerLookup: opts.candidatesPerLookup ?? 5,
			defaultCountry: opts.defaultCountry,
			defaultCountryIsInferred: opts.defaultCountryIsInferred === true,
			bareLocalityNode: loneBareLocalityNode(tree, opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP),
			parentFallback: opts.parentFallback ?? true,
			// Only enable unreachable diagnostics when a trace sink exists.
			...(opts.diagnoseUnreachable && opts.traceSink ? { diagnoseUnreachable: true } : {}),
			postcode: firstPostcodeValue(tree.roots),
			// Optional postcode-containment hint for locality lookups.
			postcodeContainmentCoherence: opts.postcodeContainmentCoherence === true,
			// Optional postcode-prefix prior and index.
			postcodePrefixPrior: opts.postcodePrefixPrior === true,
			postcodePrefixIndex: opts.postcodePrefixIndex,
			// Derive format-implied countries when not provided.
			postcodeFormatCountries:
				opts.postcodeFormatCountries ?? countriesFromPostcodeFormat(firstPostcodeValue(tree.roots)),
			fuzzyCountryScope: opts.fuzzyCountryScope,
			bias: opts.bias,
			anchorPosterior: opts.anchorPosterior,
			anchorWeight: opts.anchorWeight ?? 2,
			localeCountryPrior: opts.localeCountryPrior,
			localeCountryPriorWeight: opts.localeCountryPriorWeight ?? DEFAULT_COUNTRY_PRIOR_WEIGHT,
			capitalLevel: opts.capitalLevel,
			hardCountry: opts.hardCountry,
			// Dual-role hierarchy completion (default on, backend-dependent).
			hierarchyCompletion: opts.hierarchyCompletion ?? true,
			includeAncestors: opts.includeAncestors ?? false,
			// Optional admin containment rerank uses a pre-scanned region qualifier.
			adminContainmentRerank: opts.adminContainmentRerank === true,
			regionQualifier: firstRegionQualifier(tree.roots),
			...(opts.traceSink ? { traceSink: opts.traceSink } : {}),
			localityNodePresent: false,
			resolvedRegion: null,
			resolvedRegionNode: null,
		}

		// Optional pre-walk postcode-country coherence pass.
		// This is the only pass allowed to override `defaultCountry`.
		let postcodeScope: PostcodeCountryScope | null = null

		// Explicit country text in the tree can pre-scope the walk.
		// Explicit scope outranks inferred default scope.
		let explicitScope: string | null = null

		if (!state.defaultCountry || state.defaultCountryIsInferred) {
			explicitScope = explicitCountryScope(tree.roots)

			if (explicitScope) {
				state.defaultCountry = explicitScope
				state.defaultCountryIsInferred = false
			}
		}

		if (opts.postcodeCountryCoherence !== false && state.postcode) {
			postcodeScope = await findPostcodeCountryScope(tree.roots, this.#backend, {
				postcode: state.postcode,
				defaultCountry: state.defaultCountry,
				...(shapeVerdict?.narrowing !== undefined ? { candidateSystems: shapeVerdict.narrowing } : {}),
				...(opts.postcodeCountryCoherenceThresholdKm !== undefined
					? { thresholdKm: opts.postcodeCountryCoherenceThresholdKm }
					: {}),
			})

			if (postcodeScope) {
				// Override default country for the walk.
				state.defaultCountry = postcodeScope.country
			}
		}

		const newRoots: AddressNode[] = []

		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
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

		// If enabled, add a dropped dual-role locality as a region interpretation.
		if (state.hierarchyCompletion && state.resolvedRegion && state.resolvedRegionNode && !state.localityNodePresent) {
			this.#completeRegionRole(state.resolvedRegion, state.resolvedRegionNode)
		}

		// Admin coherence passes (default on).
		if (opts.adminCoherence !== false) {
			// Clear contradictory parent-fallback picks before coherence passes.
			applyParentFallbackContradiction(newRoots)
			await applyAdminCoherence(newRoots, this.#backend)
			// Re-resolve locality when explicit country contradicts it.
			await applyExplicitCountryCoherence(newRoots, this.#backend)
			// Re-resolve foreign region/locality pairs blocked by locale scope.
			await applyRegionCountryCoherence(newRoots, this.#backend, state.defaultCountry)
		}

		// Postcode/locality consistency pass (default on).
		if (opts.postcodeConsistency !== false) {
			applyPostcodeConsistency(newRoots, opts.postcodeConsistencyThresholdKm ?? 50, opts.postcodeConsistencyMaxMoveKm)
		}

		// Optional exact address-point tier.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Optional interpolation tier after exact points.
		if (opts.interpolation) {
			applyInterpolation(newRoots, opts.interpolation, opts.interpolationRadiusCalibration)
		}

		// Span-rescore fallback tier (default on).
		// Skip when a min-score refusal already occurred.
		if (opts.spanRescore !== false && state.minScoreRefusals === 0) {
			await applySpanRescore(newRoots, tree.raw, this.#backend, opts)
		}

		// Retry exact address-point tier once after span-rescore recovery.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Optional street-centroid tier runs last.
		if (opts.streetCentroids) {
			applyStreetCentroid(newRoots, tree.raw, opts.streetCentroids, opts.streetCountryHints ?? [])
		}

		return { raw: tree.raw, roots: newRoots }
	}

	/**
	 * Add a dropped dual-role locality as a `locality` interpretation on a resolved region node.
	 */
	#completeRegionRole(region: CoordinateOptionalPlace, regionNode: AddressNode): void {
		if (typeof region.id !== "number" || !this.#backend.coincidentLocalitiesFor) return
		const loc = pickCompletion(this.#backend.coincidentLocalitiesFor(region.id))

		if (!loc) return

		const interpretation: Interpretation = {
			tag: "locality",
			placeID: `wof:${loc.id}`,
			sourceID: `${loc.placetype}:${loc.id}`,
			lat: loc.lat,
			lon: loc.lon,
			confidence: 0,
			metadata: { relationship_type: loc.relationshipType, resolver_completed: true, resolver_name: loc.name },
		}

		regionNode.interpretations = [...(regionNode.interpretations ?? []), interpretation]
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

		// Track whether a locality node exists for hierarchy completion.
		if (placetype === "locality") {
			state.localityNodePresent = true
		}

		let resolved: CoordinateOptionalPlace | null = null

		// Skip lookup for shape-excluded postcode spans.
		if (placetype && state.lookupsRemaining > 0 && node.value.trim().length && !isShapeExcludedPostcode(node)) {
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
				decorateNode(decorated, picked.top, picked.alternatives)

				if (picked.metadata) {
					decorated.metadata = { ...decorated.metadata, ...picked.metadata }
				}

				// Retag bare-toponym repicks to the resolved admin type.
				if (decorated.metadata?.["bare_country_repick"]) {
					decorated.tag = "country"
				} else if (decorated.metadata?.["bare_region_repick"]) {
					decorated.tag = "region"
				}

				// Optional lineage attachment.
				if (state.includeAncestors && this.#backend.ancestors) {
					decorated.metadata = { ...decorated.metadata, ancestors: this.#backend.ancestors(picked.top.id) }
				}

				// Capture first resolved region for hierarchy completion.
				if (placetype === "region" && state.resolvedRegion === null) {
					state.resolvedRegion = picked.top
					state.resolvedRegionNode = decorated
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
				const hits = await this.#backend.findPlace({ ...query, placetype: band, parentID: undefined })

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

	async #lookupAndPick(
		node: AddressNode,
		placetype: string,
		parentResolved: CoordinateOptionalPlace | null,
		state: ResolutionState
	): Promise<{
		top: CoordinateOptionalPlace
		alternatives: ResolvedPlace[]
		metadata?: Record<string, unknown>
	} | null> {
		state.lookupsRemaining--

		const query: Parameters<ResolverBackend["findPlace"]>[0] = {
			text: node.value,
			placetype,
			limit: state.candidatesPerLookup,
		}

		// Optional proximity bias, which reorders candidates and leaves the candidate set intact.
		if (state.bias && state.bias.length) {
			query.bias = state.bias
		}

		// Apply resolved parent scope when available.
		if (parentResolved && typeof parentResolved.id === "number") {
			query.parentID = parentResolved.id
		}

		// Country scope precedence: parent -> default -> node hint -> hard country.
		const countryHint = node.metadata?.["country_hint"]

		// Do not apply inferred default-country filtering to country lookups.
		const defaultCountryForLookup =
			placetype === "country" && state.defaultCountryIsInferred ? undefined : state.defaultCountry

		const country =
			parentResolved?.country ??
			defaultCountryForLookup ??
			(typeof countryHint === "string" ? countryHint : undefined) ??
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
			state.regionQualifier !== undefined &&
			(!state.defaultCountry || state.defaultCountryIsInferred)

		if (containmentEligible) {
			query.regionQualifier = state.regionQualifier
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

		// For unconstrained postalcodes, probe format-implied countries only.
		if (placetype === "postalcode" && !query.country && state.postcodeFormatCountries?.length) {
			rec.check("postcode_format_probe")
			let best: ResolvedPlace | undefined

			for (const impliedCountry of state.postcodeFormatCountries) {
				try {
					const hits = await this.#backend.findPlace({ ...query, country: impliedCountry })
					const top = hits[0]

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

				return { top: best, alternatives: [] }
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
				if (!candidates.length && state.parentFallback && query.parentID !== undefined) {
					delete query.parentID
					rec.check("parent_fallback_retry")
					candidates = await this.#backend.findPlace(query)
					rec.stage("parent_fallback", candidates)
				}

				// Optional diagnostics: record other bands that can resolve this value.
				if (!candidates.length && state.diagnoseUnreachable) {
					rec.reachable(await this.#probeOtherBands(query, placetype))
				}
			} catch (error) {
				// Defensive: backend errors should not abort the whole tree walk.
				rec.check(`backend_error: ${(error as Error).message}`)
				rec.emit(null)

				return null
			}
		}

		// Optional postcode-prefix prior when postcode lookup misses.
		if (!candidates.length && placetype === "postalcode" && state.postcodePrefixPrior && state.postcodePrefixIndex) {
			const probe = probePostcodePrefix(node.value, state.postcodePrefixIndex, query.country)

			if (probe) {
				const metadata: Record<string, unknown> = {
					postcode_prefix: probe.prefix,
					postcode_prefix_ancestors: probe.node.ancestors,
					...(probe.node.radiusP95Km !== undefined ? { postcode_prefix_radius_p95_km: probe.node.radiusP95Km } : {}),
					...(probe.node.lat !== undefined && probe.node.lon !== undefined
						? { coordinate_source: "postcode_prefix" }
						: {}),
				}

				rec.check("postcode_prefix_prior")
				const prefixPlace = postcodePrefixResolvedPlace(probe.prefix, probe.node, state.postcodePrefixIndex)

				rec.emit({ id: prefixPlace.id, name: prefixPlace.name, source: "postcode_prefix" })

				return {
					top: prefixPlace,
					alternatives: [],
					metadata,
				}
			}
		}

		// Bare-toponym race: locality-tagged single spans also probe country/region.
		const isBareRace = placetype === "locality" && node === state.bareLocalityNode

		if (isBareRace) {
			rec.check("bare_race")
		}

		const bareCountry = isBareRace ? await bareCountryCandidate(this.#backend, node.value, query.country) : null
		const bareRegion = isBareRace ? await bareRegionCandidate(this.#backend, node.value, query.country) : null

		if (!candidates.length) {
			// With no locality candidates, pick the larger admin namesake.
			const admin = pickLargerAdmin(bareCountry, bareRegion)

			if (admin) {
				rec.check("empty_admin_pick")
				rec.emit({ id: admin.id, name: admin.name, source: "empty_admin" })

				return {
					top: admin,
					alternatives: [],
					metadata: admin === bareRegion ? { bare_region_repick: true } : { bare_country_repick: true },
				}
			}

			rec.emit(null)

			return null
		}

		// Optional anchor-based rerank using postcode country posterior.
		// Applied to region/locality and kept tier-safe by exact-match first.
		const anchorEligible = placetype === "region" || placetype === "locality"
		let ranked = candidates

		if (state.anchorPosterior && anchorEligible && candidates.length > 1) {
			const post = state.anchorPosterior
			const w = state.anchorWeight

			// Within-tier key uses prominence (fallback score) plus posterior boost.
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array. toSorted would double-allocate on a hot path
			ranked = [...candidates].sort((a, b) => {
				const tier = Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false)

				if (tier !== 0) return tier
				// Unknown-country candidates get zero posterior mass.
				const aKey = (a.prominence ?? a.score) + w * (a.country === undefined ? 0 : (post[a.country] ?? 0))
				const bKey = (b.prominence ?? b.score) + w * (b.country === undefined ? 0 : (post[b.country] ?? 0))

				return bKey - aKey || b.score - a.score
			})

			rec.stage("anchor", ranked)
		}

		// Optional locale-country soft prior, which adds to a candidate's score and keeps every candidate.
		// Disabled when default country or anchor posterior is present.
		if (state.localeCountryPrior && !state.defaultCountry && !state.anchorPosterior && anchorEligible) {
			ranked = rankByCountryPrior(ranked, state.localeCountryPrior, state.localeCountryPriorWeight)
			rec.stage("locale_prior", ranked)
		}

		// Importance-first rerank (skipped when anchor posterior exists).
		if (!state.anchorPosterior) {
			ranked = rankByImportance(ranked)
			rec.stage("importance", ranked)

			// Optional bounded capital promotion.
			if (state.capitalLevel) {
				ranked = promoteCapitalsWithReceipt(ranked, state.capitalLevel, node)
				rec.stage("capital", ranked)
			}
		}

		// Final containment partition.
		// It reads the address's own qualifier and preserves the exact-match tier.
		if (containmentEligible) {
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

			return { top: bareCountry, alternatives: ranked, metadata: { bare_country_repick: true } }
		}

		if (bareRegion && logPopulation(bareRegion) >= logPopulation(top) + BARE_REGION_DOMINANCE_LOG10) {
			rec.check("bare_region_repick")
			rec.emit({ id: bareRegion.id, name: bareRegion.name, source: "bare_region" })

			return { top: bareRegion, alternatives: ranked, metadata: { bare_region_repick: true } }
		}

		// Stamp fallback quality when a macro-type winner stands in.
		if (isPlacetypeFallback(placetype, top.placetype)) {
			top.resolutionQuality = "fallback"
			rec.check("placetype_fallback")
		}

		rec.emit({ id: top.id, name: top.name, source: "ranked" })

		// Trace receipts for mechanism-level observability.
		const pickMetadata = {
			...(containmentEligible ? { admin_containment: adminContainmentVerdict(ranked) } : {}),
			...(top.variantAliasExempted === true ? { variant_alias_exemption: true } : {}),
			// Mark picks admitted outside resolved parent scope.
			...((parentResolved && typeof parentResolved.id === "number" && query.parentID === undefined) ||
			top.regionScopeMiss === true
				? { parent_fallback: true }
				: {}),
		}

		return {
			top,
			alternatives: ranked.slice(1),
			...(Object.keys(pickMetadata).length ? { metadata: pickMetadata } : {}),
		}
	}
}

/**
 * Promote capitals and stamp `capital_promotion` when the leader changes.
 * Metadata only.
 */
function promoteCapitalsWithReceipt<
	T extends Pick<ResolvedPlace, "score" | "name" | "country" | "lat" | "lon"> &
		Partial<Pick<ResolvedPlace, "exactMatch" | "importance" | "prominence">>,
>(ranked: readonly T[], level: CapitalLevelFn, node: { metadata?: Record<string, unknown> }): T[] {
	const promoted = promoteCapitals(ranked, level)

	if (promoted[0] !== ranked[0]) {
		node.metadata = { ...node.metadata, capital_promotion: promoted[0]!.country ?? true }
	}

	return promoted
}
