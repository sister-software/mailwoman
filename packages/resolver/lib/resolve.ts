/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `resolveTree` — walk an `AddressTree` top-down and decorate matched nodes with resolver- supplied
 *   attribution + coordinates.
 *
 *   The walk is parent-constraint-aware: when a parent node resolves to a place id, its children's
 *   lookups are scoped to descendants of that parent. This dramatically narrows the search space
 *   for ambiguous names — `Springfield` under a resolved `Illinois` parent resolves to the IL one,
 *   not the MA one.
 */

import { matchCountry, matchSubdivision } from "@mailwoman/codex/country"
import type { AddressNode, AddressTree, ComponentTag, Interpretation } from "@mailwoman/core/decoder"
import {
	type BackendCapabilityGap,
	type ResolveNodeTrace,
	DEFAULT_PLACETYPE_MAP,
	isPlacetypeFallback,
	type ResolvedPlace,
	type ResolveOpts,
	type Resolver,
	type ResolverBackend,
	countriesFromPostcodeFormat,
} from "@mailwoman/core/resolver"

import {
	applyAdminCoherence,
	applyExplicitCountryCoherence,
	applyRegionCountryCoherence,
} from "#admin-coherence-passes"
import { adminContainmentVerdict, firstRegionQualifier, partitionByContainment } from "#admin-containment"
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
} from "#postcode-country-coherence"
import { type CoordinateOptionalPlace, postcodePrefixResolvedPlace, probePostcodePrefix } from "#postcode-prefix"
import { applyPostcodeShapeCoherence, isShapeExcludedPostcode } from "#postcode-shape-coherence"
import {
	applyPostcodeConsistency,
	applySpanRescore,
	createNodeTraceRecorder,
	DIAGNOSTIC_BANDS,
	firstPostcodeValue,
	NOOP_TRACE_RECORDER,
	pickCompletion,
	type ResolutionState,
} from "#resolve-passes"
import { applyAddressPoint, applyInterpolation, applyStreetCentroid } from "#street-tier"
import {
	type CapitalLevelFn,
	DEFAULT_COUNTRY_PRIOR_WEIGHT,
	promoteCapitals,
	rankByCountryPrior,
	rankByImportance,
} from "#toponym-prior"

/**
 * Build a `Resolver` backed by a `ResolverBackend`. The backend can be any concrete impl structurally compatible with
 * `PlaceLookup` — e.g. `new WOFSQLitePlaceLookup({ databasePath }).asResolverBackend()` or a fake for tests.
 */
export function createWOFResolver(backend: ResolverBackend): Resolver {
	return new WOFResolver(backend)
}

/**
 * #1735 (second half) — the tree's own country statement, when it is unambiguous.
 *
 * "SW1A 1AA, UK" under the en-US default parsed correctly and still failed: the walk resolved the country NODE to GB,
 * but a sibling's resolution never scopes a sibling — the postcode lookup ran under the locale-inferred `country=US`
 * hard filter and missed. An explicit country token is the address's OWN scope declaration, which outranks a locale
 * inference the same way the #912 posture ranks explicit over inferred.
 *
 * Deterministically guarded: exactly ONE country-tagged node, whose value `matchCountry` maps to one ISO country, and
 * whose value is NOT also a subdivision name — "Georgia" maps to GE _and_ names a US state, so it never pre-scopes (the
 * existing coherence passes keep handling it). Returns the alpha-2 or null.
 */
function explicitCountryScope(roots: readonly AddressNode[]): string | null {
	const countryNodes: AddressNode[] = []
	const stack = [...roots]

	while (stack.length) {
		const node = stack.pop()!

		if (node.tag === "country" && node.value.trim()) {
			countryNodes.push(node)
		}

		stack.push(...node.children)
	}

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
	 * The gazetteer artifact's self-declared coverage facts, passed through from the backend so pipeline-level consumers
	 * read them from the resolver handle they already hold. Absent on artifacts predating the coverage manifest.
	 */
	readonly artifactCoverage: Resolver["artifactCoverage"]
	/**
	 * Optional backend methods this backend omits, each naming the default-ON option it silently disables. Computed once
	 * here rather than at each guard site so a caller can read the gap before running a query that would quietly skip the
	 * feature. See `backend-capabilities.ts`.
	 */
	readonly capabilityGaps: readonly BackendCapabilityGap[]

	constructor(backend: ResolverBackend) {
		this.#backend = backend
		this.artifactCoverage = backend.artifactCoverage
		this.capabilityGaps = describeCapabilityGaps(backend)
		reportCapabilityGaps(this.capabilityGaps)
	}

	/**
	 * The `Resolver.findPlace` passthrough — one direct gazetteer probe for pipeline-level consumers (#1738's
	 * dominant-bearer guard). Bound as a method so `this.#backend` stays private.
	 */
	findPlace: Resolver["findPlace"] = (query) => this.#backend.findPlace(query)

	async resolveTree(tree: AddressTree, opts: ResolveOpts = {}): Promise<AddressTree> {
		// Postcode-shape coherence (#31, Mechanism 1): the earliest pass in the tree — pure-sync and
		// backend-free, run BEFORE `state.postcode` is read so an excluded span can never become the
		// address's postcode. Opt-in (`postcodeShapeCoherence: true`), OFF by default (D-rule: demotion
		// is the failure mode with teeth). A confirmed span's narrowed systems — the intersection of
		// its codex shape with the tree's confident sibling systems — bound the country-scope pass
		// below; a pure subset of codex's own candidate list, so it can only narrow, never widen.
		// See postcode-shape-coherence.ts.
		const shapeVerdict = opts.postcodeShapeCoherence === true ? applyPostcodeShapeCoherence(tree.roots) : null

		const state: ResolutionState = {
			lookupsRemaining: opts.maxLookups ?? 10,
			// Full replacement when `placetypeMap` is supplied — callers that want to extend rather
			// than replace should spread DEFAULT_PLACETYPE_MAP themselves.
			placetypeMap: opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP,
			minWinningScore: opts.minWinningScore ?? 0,
			candidatesPerLookup: opts.candidatesPerLookup ?? 5,
			defaultCountry: opts.defaultCountry,
			defaultCountryIsInferred: opts.defaultCountryIsInferred === true,
			bareLocalityNode: loneBareLocalityNode(tree, opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP),
			parentFallback: opts.parentFallback ?? true,
			// Requires a sink: with nowhere to record the answer the probes would be pure cost.
			...(opts.diagnoseUnreachable && opts.traceSink ? { diagnoseUnreachable: true } : {}),
			postcode: firstPostcodeValue(tree.roots),
			// #31 Mechanism 2 — forwarded to locality lookups (see #lookupAndPick). Opt-in, OFF by default.
			postcodeContainmentCoherence: opts.postcodeContainmentCoherence === true,
			// #31 Mechanism 3 — the prefix prior + its injected index (see #lookupAndPick). Opt-in, OFF by default.
			postcodePrefixPrior: opts.postcodePrefixPrior === true,
			postcodePrefixIndex: opts.postcodePrefixIndex,
			// #1589: derived here when the caller didn't thread it, so the browser cascade and the
			// drop-ins get the implied-set probe without per-caller wiring (the staged-repoint e2e
			// caught `100 00` resolving in Node and not in the browser over the same artifact).
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
			// Default-ON (#402): completion only fires for a dual-role region whose locality the parser
			// dropped, and no-ops entirely when the backend has no relation (the browser WASM resolver, or
			// a gazetteer without `coincident_roles`). Pass `hierarchyCompletion: false` to opt out.
			//
			// Default-ON is nominal on the SHIPPED backend: `WOFCandidateTableLookup` implements no
			// `coincidentLocalitiesFor`, so this attaches nothing there. Measured 2026-08-15 on FTS, which
			// does implement it, the flag changed 0 of 837 board inputs — see ResolveOpts.hierarchyCompletion.
			hierarchyCompletion: opts.hierarchyCompletion ?? true,
			includeAncestors: opts.includeAncestors ?? false,
			// #1717 stage 2 — default OFF (D-rule); the qualifier is pre-scanned like `postcode` above
			// because region and locality are siblings the walk visits independently.
			adminContainmentRerank: opts.adminContainmentRerank === true,
			regionQualifier: firstRegionQualifier(tree.roots),
			...(opts.traceSink ? { traceSink: opts.traceSink } : {}),
			localityNodePresent: false,
			resolvedRegion: null,
			resolvedRegionNode: null,
		}

		// Postcode-country coherence (#42): the one pre-walk LOOKUP pass (the shape verdict above is
		// pure-sync, backend-free), and the only mechanism allowed to override `defaultCountry`. Its three
		// sibling coherence passes re-pick nodes AFTER the walk; that shape cannot work here, because what
		// needs correcting is the walk's country SCOPE — which poisons the postcode node's own resolution,
		// the postcode-consistency fallback that then drags the locality onto it, and the hard `country`
		// filter on every admin lookup. So the verdict is taken once, up front, and the walk runs under the
		// corrected country. Default-ON (operator-promoted 2026-08-05; `false` opts out) — needs a default
		// country to correct and both a postcode and a locality to be coherent about; abstains unless
		// EXACTLY one country (never the already-coherent default) makes the pair consistent. See
		// postcode-country-coherence.ts.
		let postcodeScope: PostcodeCountryScope | null = null

		// The pass also runs with NO default in force (#1585/#861 convergence): there is nothing to
		// override, but the same exactly-one-country abstention lets the postcode+locality pair
		// CONSTRAIN an otherwise population-first walk — `Zabiče 8, 6250 Zabiče` picks the SI row
		// coherent with the SI 6250 centroid instead of the more-populous Polish namesake. The
		// browser cascade (which sets no default by design) is the consumer this exists for.
		// #1735 second half: the address's own country statement scopes the walk BEFORE anything
		// resolves — a sibling's resolution never reaches a sibling, so without this the postcode
		// lookup in "RM10 8AB, UK" ran under the locale-inferred US filter while the country node
		// resolved to GB beside it. Explicit-over-inferred, the #912 precedence, decided from the
		// tree's own text; an EXPLICIT caller scope is never overridden.
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
				...(opts.postcodeCountryCoherenceGateKm !== undefined ? { gateKm: opts.postcodeCountryCoherenceGateKm } : {}),
			})

			if (postcodeScope) {
				// The override. `hardCountry` is not cleared because it is never consulted while a
				// `defaultCountry` is set (`#lookupAndPick`'s precedence chain reaches it only as the last
				// fallback), so replacing the default is sufficient to re-scope the entire walk.
				state.defaultCountry = postcodeScope.country
			}
		}

		const newRoots: AddressNode[] = []

		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}

		// Attribution for the override, stamped on the two nodes that bought it. Additive metadata only.
		if (postcodeScope) {
			stampPostcodeCountryScope(newRoots, postcodeScope)
		}

		// The pre-scope's receipt (#1735): consumers that select country-scoped artifacts AFTER the walk
		// (geocode-core's rooftop-extract second pass) key on a scope stamp. Without this, an address whose
		// country was right FROM THE TREE never writes one — the #42 pass stays silent because the default
		// is already coherent — and the FR rooftop extract silently stops loading for "…, France" inputs
		// under a non-FR locale (six board venue rows dropped from rooftop to city centroid; the battery
		// caught it).
		if (explicitScope) {
			for (const root of newRoots) {
				if (root.tag === "country") {
					root.metadata = { ...root.metadata, explicit_country_scope: explicitScope }
				}
			}
		}

		// Dual-role hierarchy completion (#405/#415). Only when enabled, a region resolved, and the parser
		// emitted NO locality — record the dropped locality as a SECONDARY ROLE (an interpretation) on the
		// resolved region node, from the backend's precomputed coincident-roles relation (#403). One node,
		// one span, two roles — no synthesized sibling. See ResolveOpts.hierarchyCompletion.
		if (state.hierarchyCompletion && state.resolvedRegion && state.resolvedRegionNode && !state.localityNodePresent) {
			this.#completeRegionRole(state.resolvedRegion, state.resolvedRegionNode)
		}

		// Admin descendant-consistency (#263): default-ON (#895 settled drift D1; `false` opts out). Re-pick a
		// (region, locality) pair so the locality descends from the region — runs BEFORE postcode-consistency
		// (it resolves the locality the postcode pass may then refine) and before the street tiers (which key
		// off the postcode/street, not the admin coordinate this adjusts). Byte-stable when nothing fell
		// through or the backend lacks `ancestors`.
		if (opts.adminCoherence !== false) {
			await applyAdminCoherence(newRoots, this.#backend)
			// #822 — same joint-consistency family, inverse trigger: an explicit country token whose resolved
			// locality landed in the wrong country (the populous US namesake). Runs after the region pass so the
			// two never contend (region-fallthrough vs resolved-but-foreign are disjoint locality states).
			await applyExplicitCountryCoherence(newRoots, this.#backend)
			// Region-country coherence: a region qualifier the locale-inferred default-country hard filter could not
			// resolve (a foreign subdivision — "Montreal QC" under a US locale). The default filter discarded "QC" and
			// force-matched the locality to the US namesake; this re-resolves the subdivision + its same-named locality
			// under the subdivision's OWN country. Disjoint from the two passes above (unresolved region + resolved
			// locality); evidence-gated + byte-stable on the domestic path (a US region resolves under `US`).
			await applyRegionCountryCoherence(newRoots, this.#backend, state.defaultCountry)
		}

		// Postcode-consistency (#370 "Lever A"): default-ON (promoted 2026-07-04 — the corrected gate:
		// FI 231/0, SI 37/6, CZ 47/2, US byte-flat; see the ResolveOpts docstring). After the admin walk
		// (needs both the locality and the postcode resolved) and before the street tiers (which key off
		// the postcode/street, not the locality coordinate this adjusts). `false` opts out, byte-stable.
		if (opts.postcodeConsistency !== false) {
			applyPostcodeConsistency(newRoots, opts.postcodeConsistencyGateKm ?? 50)
		}

		// Address-point tier (#476): opt-in street-level exact match. After the admin walk so the
		// tier can never disturb admin attribution — it only ADDS the precise coordinate. Byte-stable
		// when opts.addressPoints is absent.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Interpolation tier (#483): strictly AFTER the exact-point block so an estimate can never
		// override a real situs point (applyInterpolation also gates on resolution_tier). Opt-in;
		// byte-stable when opts.interpolation is absent.
		if (opts.interpolation) {
			applyInterpolation(newRoots, opts.interpolation, opts.interpolationRadiusCalibration)
		}

		// Span-rescore tier (#370): default-ON (promoted 2026-06-25 — same-harness EU+AU +1pp @25km,
		// zero regressions: CZ 90→95, AT 70→73, PL 88→90, IT/PT/FR/AU flat, no-result 4→3%; fires last
		// so it only runs when every other tier left the tree unresolved, hence inert on the well-resolved
		// US path). Explicit opt-OUT via `spanRescore: false`; byte-stable then.
		if (opts.spanRescore !== false) {
			await applySpanRescore(newRoots, tree.raw, this.#backend, opts)
		}

		// A failed admin walk can leave the exact-point tier without a locality even though span-rescore
		// recovers one immediately afterward (for example, a locality the model tagged as `region`). Give
		// the exact register one bounded retry with that newly established scope. An existing situs hit is
		// returned early by applyAddressPoint, so the normal path performs no duplicate lookup; interpolation
		// remains subordinate because an exact point is allowed to replace its estimate.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints, opts.addressPointBboxFallback)
		}

		// Street-centroid tier (#1042): LAST, after span-rescore, so it can (a) union the span-rescore-recovered
		// country into its FR/national country hints (a placer-misrouted street — "Rue Sainte-Catherine" → IT — leaves
		// admin unresolved, and only span-rescore recovers the FR country signal) and (b) override a coarse recovered
		// locality with the exact street centroid. Self-gates on no house number + no existing street-level tier, so a
		// rooftop query is untouched; byte-stable when opts.streetCentroids absent.
		if (opts.streetCentroids) {
			applyStreetCentroid(newRoots, tree.raw, opts.streetCentroids, opts.streetCountryHints ?? [])
		}

		return { raw: tree.raw, roots: newRoots }
	}

	/**
	 * Record a dropped dual-role locality as a `locality` INTERPRETATION on the resolved region node (#415, generalizes
	 * #405's synthesized node). Consults `coincidentLocalitiesFor(regionID)` (O(1) map lookup — no distance math, no
	 * backend query), picks the principal city ({@link pickCompletion}: population-primary, distance tiebreak, abstain on
	 * a genuine tie), and appends an interpretation to `regionNode.interpretations`. No-op when the backend has no
	 * relation, the region isn't a dual-role place, or it abstains. The region node's primary role stays `region`; the
	 * locality rides alongside.
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
		// Always clone — never mutate input nodes.
		const decorated: AddressNode = { ...node, children: [] }

		const placetype = state.placetypeMap[node.tag as ComponentTag]

		// Track locality presence for hierarchy completion (#405): completion must NOT fire if the parser
		// already emitted a locality node (even one that failed to resolve) — it only fills a genuine
		// gap. Cheap and always-on; only consulted when hierarchyCompletion is set.
		if (placetype === "locality") {
			state.localityNodePresent = true
		}

		let resolved: CoordinateOptionalPlace | null = null

		// Shape-excluded postcode spans (letter-bearing ones keep their tag; #31 Mechanism 1) are
		// stripped of their resolve contribution — the walk does not look them up. Digit-only excluded
		// spans were retagged to `house_number` and flow through their correct sibling placetype.
		if (placetype && state.lookupsRemaining > 0 && node.value.trim().length && !isShapeExcludedPostcode(node)) {
			const picked = await this.#lookupAndPick(node, placetype, parentResolved, state)

			if (picked) {
				resolved = picked.top
				decorateNode(decorated, picked.top, picked.alternatives)

				if (picked.metadata) {
					decorated.metadata = { ...decorated.metadata, ...picked.metadata }
				}

				// #1678 thread 2 — the parse half, resolved from the atlas rather than trained in.
				//
				// The bare-toponym race exists because the model reads a lone country or region name as a
				// `locality`; the race finds the right PLACE and the node keeps the wrong TAG. So
				// `mw geocode 格鲁吉亚` lands on Georgia the country and reports `{"locality": "格鲁吉亚"}`,
				// which is a correct coordinate under a label that will mislead the moment the same toponym
				// appears inside a longer address.
				//
				// The repick metadata already marks exactly these nodes, so the correction is free: retrieval
				// established the placetype, and the tag follows it. Only the race's own picks are retagged —
				// an ordinary locality that resolved to a locality is untouched.
				if (decorated.metadata?.["bare_country_repick"]) {
					decorated.tag = "country"
				} else if (decorated.metadata?.["bare_region_repick"]) {
					decorated.tag = "region"
				}

				// Lineage attachment (#404): stamp the resolved place's ancestor chain onto metadata. Opt-in
				// + only when the backend supplies it, so the default stays byte-identical (no extra query).
				if (state.includeAncestors && this.#backend.ancestors) {
					decorated.metadata = { ...decorated.metadata, ancestors: this.#backend.ancestors(picked.top.id) }
				}

				// Capture the first resolved region (place + node) for hierarchy completion — the locality
				// interpretation is pushed onto this node in the post-walk pass.
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
	 * Which admin bands hold a value the probed band did not, keeping the country and dropping the parent.
	 *
	 * Bands come from `PLACETYPE_SPECIFICITY` rather than a list typed here: that table is already the repo's answer to
	 * how coarse a placetype is, and a second hand-kept copy would agree right up until a placetype is added. Probed
	 * coarse-to-fine so the report reads down the admin ladder.
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
				// A band the backend cannot answer for is not evidence that the key is absent from it, so it is
				// skipped rather than recorded as an empty result.
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

		// Proximity bias (viewport center, user location, …) — a SOFT re-rank the backend folds into
		// its exact-tier prominence; never a filter, so recall is untouched. This is how an ambiguous
		// bare postcode ("48026") follows the map view instead of a global population coin-flip.
		if (state.bias && state.bias.length) {
			query.bias = state.bias
		}

		// Pass the inherited parent constraint to the backend when available — `parentID` scopes to
		// the resolved parent's descendants. For `country`: a resolved parent's country wins, else
		// fall back to the caller's `defaultCountry`. Without this top-level hint a bare "IL" over a
		// multi-country gazetteer fuzzy-matches a foreign place (e.g. a French region) — see the
		// Direction-C resolver eval.
		if (parentResolved && typeof parentResolved.id === "number") {
			query.parentID = parentResolved.id
		}

		// #194: a resolved parent's country wins, then the caller's `defaultCountry`, then the confident
		// placer `hardCountry`. All three are a HARD candidate filter. The placer's `hardCountry` is gated
		// upstream on high confidence (so it only fires when the model is sure), and on a miss the node is
		// left UNRESOLVED rather than re-resolved globally: the off-continent rows are precisely the ones
		// whose locality isn't in the country's gazetteer slice, so a global retry would just re-admit the
		// wrong-continent guess the hard filter exists to drop ("in-region or unresolved"). Measured: a
		// global fallback collapses back to the soft-prior baseline (FI p90 3050, PL p90 1078); pure-hard
		// collapses the tail (FI 18 km, PL p99 8172→494) at a coverage-bounded recall cost.
		// #833 forward linkage: a node's own `country_hint` (an address-system recognizer's derived country —
		// today `recognizeUSRegions` stamping "US" on a recognized closed-set US state) constrains THIS node's
		// lookup when the caller supplied no locale/default country. A caller scope outranks this derived hint:
		// `WA` is both Washington and Western Australia, so en-AU must reach the AU candidate instead of being
		// overwritten by the US-only recognizer. A genuine foreign subdivision under the wrong locale is recovered
		// later by region-country coherence after the scoped lookup abstains.
		const countryHint = node.metadata?.["country_hint"]

		// A locale-INFERRED default country never filters a `country`-placetype lookup: the span names a
		// country outright, and the filter can only admit the scope country itself (bare "Germany" under
		// the en-US default filtered out the DE row; the unresolved span then fell to a US locality whose
		// historical alias is "Germany, Ohio"). An EXPLICIT caller scope stays supreme, matching the #912
		// posture; parent evidence and the confident placer are untouched.
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

		// #1585: the locale hint's country rides on every primary lookup as the TYPO-FUZZY tier's scope.
		// Deliberately set even when `query.country` is (the backend ignores it there — the hard filter
		// is already narrower): the field's contract lives in one place, the backend.
		if (state.fuzzyCountryScope) {
			query.fuzzyCountry = state.fuzzyCountryScope
		}

		// Admin-containment re-rank (#1717 stage 2): thread the tree's region qualifier onto locality
		// lookups so a capable backend can vouch for (and surface) the candidates that sit UNDER it.
		// Stands down under an EXPLICIT caller country scope (the #912 posture — only a locale-INFERRED
		// scope is bypassable by the address's own evidence); the resolved-parent and placer scopes are
		// left alone, since a resolved parent usually IS the qualifier and the injection dedupes.
		const containmentEligible =
			state.adminContainmentRerank &&
			placetype === "locality" &&
			state.regionQualifier !== undefined &&
			(!state.defaultCountry || state.defaultCountryIsInferred)

		if (containmentEligible) {
			query.regionQualifier = state.regionQualifier
		}

		// Coordinate-first: hand the sibling postcode to locality lookups so the backend can inject
		// postcode-proximal candidates the name-match would miss. Only for locality (the placetype both
		// `locality` and `dependent_locality` map to); other placetypes ignore it. The containment flag
		// (#31, Mechanism 2) asks a coordinate-first backend to re-rank the candidates by proximity to
		// the postcode's own centroid — opt-in, OFF by default.
		if (placetype === "locality" && state.postcode) {
			query.postcode = state.postcode

			if (state.postcodeContainmentCoherence) {
				query.postcodeContainmentCoherence = true
			}
		}

		// #1721 resolver-interior trace. Stage orders hold the SAME candidate objects across re-ranks
		// (every stage reorders, never clones), which is what lets emit assemble a per-stage rank
		// vector per row. The no-sink walk talks to the frozen no-op recorder — zero per-event branches.
		const rec = state.traceSink ? createNodeTraceRecorder(state.traceSink) : NOOP_TRACE_RECORDER

		// The query is SNAPSHOT, not bound live. `emit` reads `ctx.query.parentID` at the END of the walk, and the
		// parent-fallback retry `delete`s that key mid-lookup — so binding the object itself lets a later mutation
		// rewrite history. That is how 196 lookups which every one of them carried a parent came out of the
		// constraint census reading `parentID: absent`.
		rec.bind(node, placetype, { ...query }, state.candidatesPerLookup)

		let candidates: ResolvedPlace[]

		// #1589: a `postalcode` whose FORMAT implies specific countries, with no surviving country
		// constraint, probes exactly the implied set — most populous hit wins, and an all-miss
		// leaves the candidate set EMPTY rather than falling through to the unconstrained fold:
		// `100 00` space-strips to `10000`, which answers Troyes FR while the CZ rows sit in the
		// artifact under both keyings; a scoped empty must stay empty (the same contract as the
		// fuzzy tier's, #1585). The postcode-prefix prior below still gets its turn on the empty
		// set — its index is country-scoped by construction, so it is not the fold this branch
		// exists to avoid (the B3 tests hold that path).
		if (placetype === "postalcode" && !query.country && state.postcodeFormatCountries?.length) {
			rec.gate("postcode_format_probe")
			let best: ResolvedPlace | undefined

			for (const impliedCountry of state.postcodeFormatCountries) {
				try {
					const hits = await this.#backend.findPlace({ ...query, country: impliedCountry })
					const top = hits[0]

					// `score` is the backend's own population-first ranking metric, so comparing the
					// per-country winners by it keeps the cross-country pick population-first too.
					if (top && (!best || top.score > best.score)) {
						best = top
					}
				} catch {
					// A per-country probe failure reads as a miss for that country, never an abort.
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

				// #1731: the backend's interior region-scope fallback, surfaced as a gate — the resolver
				// never sees the scoped probe miss, only the stamp the re-admitted rows carry.
				if (candidates[0]?.regionScopeMiss) {
					rec.gate("region_scope_miss")
				}

				// Parent soft-gating: `parentID` is a HARD descendant filter in the backend, which wrongly
				// zeroes the result when the parent resolved wrong OR the gazetteer hierarchy is incomplete
				// (a real locality whose `ancestors` chain is missing its region). Rather than turn a
				// resolvable node into an unresolved one, retry once WITHOUT the parent constraint — we
				// prefer a parent-scoped hit but never sacrifice recall. The country constraint is kept, so
				// this still can't wander to a foreign place. Same logical resolution → no extra budget.
				if (!candidates.length && state.parentFallback && query.parentID !== undefined) {
					delete query.parentID
					rec.gate("parent_fallback_retry")
					candidates = await this.#backend.findPlace(query)
					rec.stage("parent_fallback", candidates)
				}

				// DIAGNOSTIC ONLY, and after every real attempt: which OTHER bands hold this value. The answer never
				// becomes the pick — a band the model did not ask for is not evidence about what the string means —
				// but it separates the two facts a `null` cannot: a key we hold under another placetype is a
				// reachability failure the tag caused, while a key nowhere is coverage. Off by default; one extra call
				// per band per miss.
				if (!candidates.length && state.diagnoseUnreachable) {
					rec.reachable(await this.#probeOtherBands(query, placetype))
				}
			} catch (error) {
				// Defensive: a backend failure should not abort the whole tree walk. Leave the node with
				// its classifier attribution intact.
				//
				// The reason rides the gate name. A bare `backend_error` cannot tell a closed database from a
				// finalized statement from a genuine query fault, which is what made three full-board constraint
				// runs unreadable — 64 of 591 rows errored and the census could not say why.
				rec.gate(`backend_error: ${(error as Error).message}`)
				rec.emit(null)

				return null
			}
		}

		// Postcode-prefix prior (#31, Mechanism 3): when a `postalcode` node misses the gazetteer, derive
		// the code's prefix and probe the injected PFX1 index (structural — never a model input). A hit
		// resolves the node to a synthetic place (id 0), carrying a coordinate ONLY when the index node
		// does — the ancestry-only tier stays coordinate-free (B3-3's 0% half, meaning-of-zero). The
		// prior's payload is returned as node metadata for #walk to stamp. Opt-in via `postcodePrefixPrior`
		// + `postcodePrefixIndex`; OFF by default (D-rule: the PCN1 posture).
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

				rec.gate("postcode_prefix_prior")
				const prefixPlace = postcodePrefixResolvedPlace(probe.prefix, probe.node, state.postcodePrefixIndex)

				rec.emit({ id: prefixPlace.id, name: prefixPlace.name, source: "postcode_prefix" })

				return {
					top: prefixPlace,
					alternatives: [],
					metadata,
				}
			}
		}

		// The bare-toponym country race (fix B of the bare-country class): a lone locality-tagged span
		// also races the `country` placetype, because the parser tags bare country names `locality`
		// about half the time ("Japan", "China") and the locality filter makes the country row
		// unreachable at any rank. Runs ONLY for the tree's single value-bearing node, so every
		// address-shaped input is byte-stable. The locality winner's prominence arbitrates below;
		// with no locality candidates at all, a country hit resolves the span outright.
		const isBareRace = placetype === "locality" && node === state.bareLocalityNode

		if (isBareRace) {
			rec.gate("bare_race")
		}

		const bareCountry = isBareRace ? await bareCountryCandidate(this.#backend, node.value, query.country) : null
		const bareRegion = isBareRace ? await bareRegionCandidate(this.#backend, node.value, query.country) : null

		if (!candidates.length) {
			// With no locality candidates at all, the admin namesake with the larger population answers
			// outright (the same precedence the dominance rule below applies).
			const admin = pickLargerAdmin(bareCountry, bareRegion)

			if (admin) {
				rec.gate("empty_admin_pick")
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

		// Postcode-anchor re-rank (#369): when a country posterior is supplied (from the address's
		// postcode), boost candidates by `anchorWeight * posterior[candidate.country]` and re-sort, so a
		// postcode that pins the country pulls the right-country place over a higher-BM25 foreign namesake
		// (the "Berlin DE vs Berlin US" class the #59 harness measured). No-op when `anchorPosterior` is
		// undefined (the default) → byte-identical resolution.
		//
		// Applied to BOTH region and locality — the two placetypes that suffer cross-country namesake/
		// abbreviation collisions a country posterior can break. The region case is the one #447's window
		// fix couldn't reach: a bare 2-letter abbreviation is shared across countries ("VT" is
		// both Vermont and Viterbo; "ME" both Maine and Messina), so with no country signal the score
		// picks the wrong one — and because resolveTree resolves region FIRST and inherits its country
		// down, a wrong region poisons the locality too. The postcode posterior breaks the tie at the
		// region, and the right country then flows to the locality. (Country/macroregion/county are
		// excluded: they don't exhibit this collision class and carry country via `parentID` when nested.)
		//
		// Tier-SAFE ordering: the candidate's exact-match flag is the PRIMARY key, so the country pin
		// never crosses the exact/partial boundary. WITHIN a tier, `score + anchorWeight * posterior`
		// applies the (soft) country boost. So a confident US postcode keeps the US EXACT region
		// ("ME" → Maine) ahead of a more-populous US PARTIAL match (Missouri) AND, within the exact
		// tier, ahead of a foreign exact match (Messina IT); a soft posterior still blends with score.
		// (A plain additive re-rank loses the tier — it isn't encoded in `score` — and flips
		// "ME" → Missouri / "PA" → Alabama. Backends that don't set `exactMatch` degrade to additive.)
		const anchorEligible = placetype === "region" || placetype === "locality"
		let ranked = candidates

		if (state.anchorPosterior && anchorEligible && candidates.length > 1) {
			const post = state.anchorPosterior
			const w = state.anchorWeight

			// #928 root cause: this sort's within-tier key was `score + w·posterior` — RAW SCORE order,
			// the exact metric #910 deprecated inside the exact tier as bm25-length-poisoned (a famous
			// place's alias-heavy doc reads ~15 pts WORSE than a tiny namesake's clean one; #905
			// measured it). Before #910 the anchor-off path also sorted by score, so the two paths
			// agreed; after, anchor-ON silently reverted to the poisoned metric — a CORRECT GB@1.00
			// pin flipped "London SE15 1DD" to a US namesake because +w·1.0 can't bridge the bm25 gap.
			// The within-tier key is now the backend's PROMINENCE (population + proximity, #938 units)
			// with the posterior as the additive country pin; score stays the final tiebreak. Backends
			// that don't populate `prominence` degrade to the additive score behavior.
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
			ranked = [...candidates].sort((a, b) => {
				const tier = Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false)

				if (tier !== 0) return tier
				// A candidate with no country gets no posterior mass rather than an index by `undefined`, which reads
				// every unknown-country row as the same key.
				const aKey = (a.prominence ?? a.score) + w * (a.country === undefined ? 0 : (post[a.country] ?? 0))
				const bKey = (b.prominence ?? b.score) + w * (b.country === undefined ? 0 : (post[b.country] ?? 0))

				return bKey - aKey || b.score - a.score
			})

			rec.stage("anchor", ranked)
		}

		// Locale-country soft prior (#27) — the #912 lever's other half, at the tier that decides a bare
		// toponym the model tagged `locality`. `--locale en-GB "Whitby"` answers Whitby, Ontario while
		// `--default-country GB "Whitby"` answers the gold, because the CLI DROPS the locale-inferred
		// country for this shape rather than choosing between "hard filter" and "nothing". This is the
		// third option: an additive bonus inside the exact tier, never a filter.
		//
		// Three stand-downs, in the order they matter. A `defaultCountry` makes the prior a no-op by
		// construction (every candidate is already in it), so we skip the work rather than pretend. An
		// `anchorPosterior` is derived from the address's OWN postcode — evidence, which outranks a guess
		// about where the user is sitting. And an absent prior is the SHIPPED default: `ResolveOpts`
		// documents why (the weight that flips the four bare GB rows and the weight that holds the en-US
		// board are disjoint intervals), so this is inert unless a caller opts in.
		//
		// Runs BEFORE the importance key deliberately, matching span-rescore: fame is the stronger signal
		// wherever it has been measured, and it leaves an unscored candidate exactly where the prior put it.
		if (state.localeCountryPrior && !state.defaultCountry && !state.anchorPosterior && anchorEligible) {
			ranked = rankByCountryPrior(ranked, state.localeCountryPrior, state.localeCountryPriorWeight)
			rec.stage("locale_prior", ranked)
		}

		// Importance-first (#17/#28). Before this key a bare famous name was decided on POPULATION
		// alone, which is measurably the wrong prior for the class: `Whitby` answered Whitby, Ontario
		// (128,377) over Whitby, North Yorkshire (13,130), 5,508 km from where the person meant. Fame is
		// what a bare toponym is asking about, and the candidate build's blended `importance` column
		// measures it. Tier-safe and positive-evidence-only (an UNSCORED candidate keeps the rank
		// population gave it; only the scored ones permute), so it abstains byte-stably on an artifact
		// that predates the column.
		//
		// Skipped outright when an anchor posterior is in force. Fame is the prior of LAST resort: it answers
		// "which one did you probably mean" only when nothing in the query answered it, and a #369 posterior is
		// derived from the address's OWN postcode. Evidence outranks a prior. See `toponym-prior.ts`.
		if (!state.anchorPosterior) {
			ranked = rankByImportance(ranked)
			rec.stage("importance", ranked)

			// #1880 — bounded capital promotion, directly above the fame key it corrects and below the
			// containment partition (the qualifier is the address's own text; evidence outranks a prior).
			// Same stand-down as fame: an anchor posterior is postcode evidence and silences the prior.
			if (state.capitalLevel) {
				ranked = promoteCapitalsWithReceipt(ranked, state.capitalLevel, node)
				rec.stage("capital", ranked)
			}
		}

		// Admin-containment partition (#1717 stage 2): the LAST soft re-rank, after the anchor/fame keys
		// above, because the qualifier is the address's OWN text — evidence, which outranks a prior. The
		// backend already put contained rows first; this second partition is required, not belt-and-
		// braces: `rankByImportance` just re-ordered the exact tier by fame, and Richmond, Virginia
		// outscores Richmond, North Yorkshire on importance — without this the lever loses exactly where
		// fame disagrees with the qualifier (the shared-function partition, tier-safe + stable, so it can
		// never promote a contained partial match over an exact one). No stamps → identity → byte-stable
		// on any backend that ignored `regionQualifier`.
		if (containmentEligible) {
			ranked = partitionByContainment(
				ranked,
				(c) => c.containedByQualifier === true,
				(c) => c.exactMatch === true
			)

			rec.stage("containment", ranked)
		}

		// Exact-type preference (#718): when the placetype-equivalence group let a broader admin tier
		// (`macroregion`/`macrocounty`) into the candidate pool, prefer a candidate of the EXACT
		// requested type over the macro fallback — a real `region` (US state, DE Bundesland, ES
		// provincia) must win over a same-name macroregion namesake, so no real region silently
		// downgrades to a macro. STABLE partition: exact-type candidates keep their (already-ranked)
		// relative order ahead of fallbacks, so the score / anchor re-rank survives WITHIN each tier.
		// No-op for placetypes without a macro fallback (the byte-stable default) and when every
		// candidate is the same tier.
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
			rec.gate("min_score_reject")
			rec.emit(null)

			return null
		}

		// The admin side of the bare-toponym race. The COUNTRY row wins on prominence alone —
		// Japan-the-country (pop 126M) over Japan, Pennsylvania (pop 0) — while the REGION row must
		// DOMINATE the locality winner by {@link BARE_REGION_DOMINANCE_LOG10} in log-population:
		// prominence saturates at the backend's populationBoost cap, so the margin is measured on the
		// raw populations, and the margin is what keeps bare "New York" on the city (state 19.6M vs
		// city 8.8M = 0.35, under the cut) while bare "Georgia" promotes to the 11M state over the
		// Vermont hamlet (margin 3.4). A bare name with no admin namesake never reaches these lines,
		// and the displaced locality stays first among the alternatives either way.
		if (bareCountry && (bareCountry.prominence ?? bareCountry.score) > (top.prominence ?? top.score)) {
			rec.gate("bare_country_repick")
			rec.emit({ id: bareCountry.id, name: bareCountry.name, source: "bare_country" })

			return { top: bareCountry, alternatives: ranked, metadata: { bare_country_repick: true } }
		}

		if (bareRegion && logPopulation(bareRegion) >= logPopulation(top) + BARE_REGION_DOMINANCE_LOG10) {
			rec.gate("bare_region_repick")
			rec.emit({ id: bareRegion.id, name: bareRegion.name, source: "bare_region" })

			return { top: bareRegion, alternatives: ranked, metadata: { bare_region_repick: true } }
		}

		// Fallback-observability (#718): if the winner is a macro-type AND no exact-type candidate
		// existed for this span, annotate that a broader tier stood in for the true one. Additive —
		// identity/coordinate are unchanged; only `metadata.resolution_quality` is stamped downstream.
		if (isPlacetypeFallback(placetype, top.placetype)) {
			top.resolutionQuality = "fallback"
			rec.gate("placetype_fallback")
		}

		rec.emit({ id: top.id, name: top.name, source: "ranked" })

		// The trace stamps (#1717 stage 2 / #1719's rule): an opted-in mechanism that cannot fire — a
		// pre-sidecar artifact, an incapable backend — must say so in the result, not degrade silently.
		// The parse-side census cannot see resolver mechanisms, so these stamps are its census surface.
		// admin_containment asserts a question was asked; variant_alias_exemption (#1893) asserts the
		// winning candidate reached the top BECAUSE the exemption spared it the cross-country penalty —
		// the winner-level firing receipt, same posture as capital_promotion.
		const pickMetadata = {
			...(containmentEligible ? { admin_containment: adminContainmentVerdict(ranked) } : {}),
			...(top.variantAliasExempted === true ? { variant_alias_exemption: true } : {}),
		}

		return {
			top,
			alternatives: ranked.slice(1),
			...(Object.keys(pickMetadata).length ? { metadata: pickMetadata } : {}),
		}
	}
}

/**
 * #1880's promotion plus its firing receipt, in one seam: when the promotion changes the race's leading candidate, the
 * node is stamped `capital_promotion` with the promoted candidate's country — the same posture as
 * `postcode_country_scope`, a mechanism reporting that it SPOKE apart from whether the outcome moved, so an unchanged
 * verdict downstream can never mean either "harmless" or "never ran". Metadata-only; nothing reads it to rank.
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
