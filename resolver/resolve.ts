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

import type { AddressNode, AddressTree, ComponentTag, Interpretation } from "../decoder/types.js"
import { findRescoreCandidate, hasResolvedPlace } from "./span-rescore.js"
import {
	type AddressPointLookup,
	type CoincidentLocality,
	DEFAULT_PLACETYPE_MAP,
	type InterpolationLookup,
	isPlacetypeFallback,
	type PlacetypeMap,
	type ResolvedPlace,
	type ResolveOpts,
	type Resolver,
	type ResolverBackend,
} from "./types.js"

/**
 * Build a `Resolver` backed by a `ResolverBackend`. The backend can be any concrete impl
 * structurally compatible with `PlaceLookup` — e.g. `new WofSqlitePlaceLookup({ databasePath
 * }).asResolverBackend()` or a fake for tests.
 */
export function createWofResolver(backend: ResolverBackend): Resolver {
	return new WofResolver(backend)
}

interface ResolutionState {
	lookupsRemaining: number
	placetypeMap: PlacetypeMap
	minWinningScore: number
	candidatesPerLookup: number
	defaultCountry?: string
	parentFallback: boolean
	/**
	 * The address's postcode string, extracted once up front, passed to locality lookups so a
	 * coordinate-first backend can inject postcode-proximal locality candidates.
	 */
	postcode?: string
	/** Postcode-anchor country posterior (#369). Undefined = no re-rank (byte-stable default). */
	anchorPosterior?: Record<string, number>
	/** Weight on the posterior in the locality re-rank. Only used when `anchorPosterior` is set. */
	anchorWeight: number
	/**
	 * #743/#194 confident-placer country as a HARD filter (empty→unresolved, no global retry). Off =
	 * undefined.
	 */
	hardCountry?: string
	/** Dual-role hierarchy completion (#405). Off by default → byte-stable. */
	hierarchyCompletion: boolean
	/** Attach ancestor lineage to each resolved node (#404). Off by default → byte-stable. */
	includeAncestors: boolean
	/**
	 * Set while resolving when ANY tree node maps to the `locality` placetype (resolved or not) — the
	 * completion only fires when the parser emitted no locality at all, never to override one.
	 */
	localityNodePresent: boolean
	/** The first region that resolved (its place — for the coincident-roles lookup). */
	resolvedRegion: ResolvedPlace | null
	/**
	 * The decorated region NODE that produced {@link resolvedRegion} — completion pushes the locality
	 * interpretation onto it in place (no synthesized sibling).
	 */
	resolvedRegionNode: AddressNode | null
}

/**
 * Pick the completion locality when an admin maps to several coincident same-name candidates
 * (#405). Population is the PRIMARY signal — the principal city is the populous one, and it can sit
 * FARTHER from the admin centroid than a tiny same-name hamlet (the Niigata case from #403).
 * Nearest centroid breaks a population tie; a genuine tie (same population AND distance) ABSTAINS
 * rather than guess.
 */
function pickCompletion(candidates: readonly CoincidentLocality[]): CoincidentLocality | null {
	if (candidates.length === 0) return null
	if (candidates.length === 1) return candidates[0]!
	const ranked = [...candidates].sort((a, b) => b.population - a.population || a.distanceKm - b.distanceKm)
	const [first, second] = ranked
	if (first!.population === second!.population && first!.distanceKm === second!.distanceKm) return null
	return first!
}

/**
 * Find the first postcode value anywhere in the tree (a one-shot pre-scan; postcode and locality
 * are siblings, so the top-down walk wouldn't otherwise let the locality lookup see it).
 */
function firstPostcodeValue(roots: readonly AddressNode[]): string | undefined {
	const stack = [...roots]
	while (stack.length > 0) {
		const n = stack.pop()!
		if (n.tag === "postcode" && n.value.trim().length > 0) return n.value.trim()
		stack.push(...n.children)
	}
	return undefined
}

/** Street-name component tags that, with the street node itself, reconstruct the full street string. */
const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Reassemble the full street string from the street node's subtree (#483 coverage fix). The parser
 * nests the directional/suffix as `street_prefix`/`street_suffix` CHILDREN of `street`
 * (containment.ts), so `street.value` alone is the bare base name ("Sheldon" for "East Sheldon Rd")
 * — which misses the coordinate shards keyed on the FULL normalized name. Collect street + its
 * prefix/particle/suffix descendants (NOT house_number/unit, which also nest under street), order
 * by span offset, and join.
 */
function assembleStreetValue(streetNode: AddressNode, directionalUnit?: AddressNode): string {
	const parts: AddressNode[] = []
	const stack = [streetNode]
	while (stack.length > 0) {
		const n = stack.pop()!
		if (STREET_NAME_TAGS.has(n.tag) && n.value.trim()) parts.push(n)
		stack.push(...n.children)
	}
	// #718 admin-tail: a directional quadrant the model mis-tagged `unit` ("1532 Taylor Street NE" →
	// [unit] "NE") folds back into the street key by span order, so the situs/interp lookup matches the
	// shard's "taylor street northeast" (the lookup normalizer expands the abbreviation). Lookup-key
	// only — the parse output and admin resolution are untouched. Byte-stable when absent (undefined).
	if (directionalUnit && directionalUnit.value.trim()) parts.push(directionalUnit)
	parts.sort((a, b) => a.start - b.start)
	return parts.map((n) => n.value.trim()).join(" ")
}

/**
 * Directional quadrant values the model sometimes emits as a `unit` node instead of inside the
 * street subtree (#718 admin-tail diagnostic: ~19% of the admin-fallback tail, 83% of DC). Folded
 * into the street lookup key by {@link assembleStreetValue}; the situs/interp lookup normalizer
 * expands the abbreviation ("ne" → "northeast") so the shard's full street name matches.
 */
const STREET_DIRECTIONAL_UNITS: ReadonlySet<string> = new Set([
	"n",
	"s",
	"e",
	"w",
	"ne",
	"nw",
	"se",
	"sw",
	"north",
	"south",
	"east",
	"west",
	"northeast",
	"northwest",
	"southeast",
	"southwest",
])
function isDirectionalUnit(value: string): boolean {
	return STREET_DIRECTIONAL_UNITS.has(value.trim().toLowerCase().replace(/\./g, ""))
}

/**
 * Address-point tier (#476): find `street` + `house_number` in the tree (first occurrence,
 * depth-first), scope by the tree's postcode/locality values, and on an exact hit stamp the point
 * onto the STREET node's metadata. Additive only — admin resolution is never altered.
 */
function applyAddressPoint(roots: AddressNode[], lookup: AddressPointLookup): void {
	let street: AddressNode | undefined
	let houseNumber: AddressNode | undefined
	let directionalUnit: AddressNode | undefined
	let locality: string | undefined
	let postcode: string | undefined
	const stack = [...roots]
	while (stack.length > 0) {
		const n = stack.pop()!
		if (n.tag === "street" && !street) street = n
		if (n.tag === "house_number" && !houseNumber) houseNumber = n
		if (n.tag === "unit" && !directionalUnit && isDirectionalUnit(n.value)) directionalUnit = n
		if (n.tag === "locality" && !locality && n.value.trim()) locality = n.value.trim()
		if (n.tag === "postcode" && !postcode && n.value.trim()) postcode = n.value.trim()
		stack.push(...n.children)
	}
	if (!street || !houseNumber) return
	const hit = lookup.find({
		street: assembleStreetValue(street, directionalUnit),
		number: houseNumber.value,
		postcode,
		locality,
	})
	if (!hit) return
	street.metadata = {
		...street.metadata,
		address_point: { lat: hit.lat, lon: hit.lon, source: hit.source, release: hit.release },
		resolution_tier: "address_point",
	}
}

/**
 * House-number interpolation tier (#483): the third rung, consulted ONLY when the exact
 * address-point tier ({@link applyAddressPoint}) did NOT already stamp the street node
 * (`resolution_tier === "address_point"`). That gate IS the "after the exact-point fall-through" —
 * an estimate never overwrites a real situs point. Postcode-scoped (no locality — the interpolators
 * abstain statewide without a postcode). Stamps a DISTINCT metadata key (`interpolated_point`,
 * never `address_point`). Additive only — admin resolution is untouched.
 */
function applyInterpolation(roots: AddressNode[], lookup: InterpolationLookup, radiusCalibration?: number): void {
	let street: AddressNode | undefined
	let houseNumber: AddressNode | undefined
	let directionalUnit: AddressNode | undefined
	let postcode: string | undefined
	const stack = [...roots]
	while (stack.length > 0) {
		const n = stack.pop()!
		if (n.tag === "street" && !street) street = n
		if (n.tag === "house_number" && !houseNumber) houseNumber = n
		if (n.tag === "unit" && !directionalUnit && isDirectionalUnit(n.value)) directionalUnit = n
		if (n.tag === "postcode" && !postcode && n.value.trim()) postcode = n.value.trim()
		stack.push(...n.children)
	}
	if (!street || !houseNumber) return
	// The fall-through gate: an exact situs point already won — never override it with an estimate.
	if (street.metadata?.["resolution_tier"] === "address_point") return
	const hit = lookup.find({ street: assembleStreetValue(street, directionalUnit), number: houseNumber.value, postcode })
	if (!hit) return
	// Conformal-calibrated radius when the caller supplies a multiplier (#374): the raw half-segment
	// heuristic underestimates the true spread (~72% coverage on Travis); ×1.70 → a 90% bound. Default
	// (no multiplier) keeps the raw value, byte-stable. Preserve the raw radius for transparency.
	const calibrated = radiusCalibration ? Math.round(hit.uncertaintyM * radiusCalibration) : hit.uncertaintyM
	street.metadata = {
		...street.metadata,
		interpolated_point: { lat: hit.lat, lon: hit.lon, source: hit.source, release: hit.release },
		resolution_tier: "interpolated",
		uncertainty_m: calibrated,
		...(radiusCalibration ? { uncertainty_raw_m: hit.uncertaintyM, uncertainty_calibration: radiusCalibration } : {}),
		interpolation_method: hit.method,
		...(hit.parityMatched !== undefined ? { parity_matched: hit.parityMatched } : {}),
		...(hit.bracket !== undefined ? { interpolation_bracket: hit.bracket } : {}),
	}
}

/**
 * Span-rescore tier (#370): opt-in last-resort locality recovery. Runs ONLY when the tree resolved
 * NOTHING (the #685 brake — never disturb a working coordinate). Enumerates raw-token spans, exact-
 * matches the same-country gazetteer (longest-wins + postcode-consistency gate; see
 * `span-rescore.ts`), and on a hit INJECTS a resolved `locality` node decorated exactly like a
 * normally-resolved one. Byte-stable when `opts.spanRescore` is unset. Async (it queries the
 * backend), so it's awaited.
 */
async function applySpanRescore(
	roots: AddressNode[],
	raw: string,
	backend: ResolverBackend,
	opts: ResolveOpts
): Promise<void> {
	if (hasResolvedPlace(roots)) return // already resolved — never second-guess a working coordinate
	const hit = await findRescoreCandidate(raw, roots, backend, {
		country: opts.defaultCountry,
		postcode: firstPostcodeValue(roots),
		gateKm: opts.spanRescoreGateKm,
	})
	if (!hit) return
	const node: AddressNode = {
		tag: "locality",
		value: hit.text,
		start: hit.start,
		end: hit.end,
		// No model confidence for a post-hoc recovery; a mid-tier value marks it as recovered, not asserted.
		confidence: 0.5,
		children: [],
	}
	decorateNode(node, hit.place, [])
	// `rescore_gated` carries the gate's precision signal as an EXPLICIT handle — NOT folded into the
	// calibrated `confidence`, which would break the isotonic guarantee (a true calibrated 0.83 must not
	// be confused with a rescore plug-in estimate; DeepSeek 2026-06-23). true = postcode gate fired
	// (high-precision); false = ungated (no postcode→point coverage for this country, ~83%-precision).
	node.metadata = { ...(node.metadata ?? {}), span_rescore: true, rescore_gated: hit.gated }
	roots.push(node)
}

// TODO(resolver-extraction): this is @mailwoman/spatial's `haversine`. core can't import spatial (spatial
// → core cycle); fold into the shared package once the resolver is lifted out of core to its own root pkg.
const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
	const R = 6371
	const dLat = ((bLat - aLat) * Math.PI) / 180
	const dLon = ((bLon - aLon) * Math.PI) / 180
	const la1 = (aLat * Math.PI) / 180
	const la2 = (bLat * Math.PI) / 180
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(h))
}

/** A resolved node carries a real coordinate (placeId set + non-zero lat/lon). */
function isResolvedWithCoord(n: AddressNode): boolean {
	return !!(n.placeId && typeof n.lat === "number" && typeof n.lon === "number" && (n.lat !== 0 || n.lon !== 0))
}

/**
 * Postcode-disambiguated locality selection (#370 "Lever A"). The single biggest miss on the EU/AU
 * panel is a same-named town resolved to the WRONG instance — "06260 Saint-Pierre" lands 617 km off
 * — while the postcode that would disambiguate it (06260 → Alpes-Maritimes) sits resolved in the
 * same tree, discarded because the coordinate-picker prefers the (wrong) locality node and never
 * cross- checks it. This post-walk pass closes that loop, backend-agnostically and with no extra
 * query:
 *
 * 1. Find the resolved postcode's coordinate (the trustworthy anchor — a postcode is unambiguous
 *    within a country in a way a town name is not).
 * 2. For each resolved locality node farther than `gateKm` from it: re-pick the same-named candidate
 *    from the node's already-captured `alternatives` that is NEAREST the postcode and within the
 *    gate. This keeps locality granularity at the CORRECT instance.
 * 3. If no alternative reconciles, the locality instance is unreliable — fall its coordinate back to
 *    the postcode point (right area, the safe answer) and flag `postcode_city_mismatch`.
 *
 * Only fires where the postcode resolved to a point, so it composes with postcode coverage (#193) —
 * add a country's postcodes and this immediately disambiguates its same-named towns. Default-off
 * via `opts.postcodeConsistency`; byte-stable when unset.
 */
function applyPostcodeConsistency(roots: readonly AddressNode[], gateKm: number): void {
	// The resolved postcode anchor (first one with a real coordinate).
	let anchor: { lat: number; lon: number } | null = null
	const findAnchor: AddressNode[] = [...roots]
	while (findAnchor.length > 0) {
		const n = findAnchor.pop()!
		if (n.tag === "postcode" && isResolvedWithCoord(n)) {
			anchor = { lat: n.lat!, lon: n.lon! }
			break
		}
		findAnchor.push(...n.children)
	}
	if (!anchor) return // no postcode→point — nothing to disambiguate against (gate can't fire)

	const stack: AddressNode[] = [...roots]
	while (stack.length > 0) {
		const node = stack.pop()!
		stack.push(...node.children)
		if ((node.tag !== "locality" && node.tag !== "dependent_locality") || !isResolvedWithCoord(node)) continue
		if (haversineKm(anchor.lat, anchor.lon, node.lat!, node.lon!) <= gateKm) continue // already consistent

		// Re-pick: the same-named candidate nearest the postcode, within the gate. `alternatives` is
		// typed `unknown[]` on the node (decoder/types.ts can't import resolver types) — they ARE the
		// `ResolvedPlace` runner-ups decorateNode attached, so the cast is sound.
		const alts = (node.alternatives as ResolvedPlace[] | undefined) ?? []
		const reconciling = alts
			.filter((a) => a.lat !== 0 || a.lon !== 0)
			.map((a) => ({ a, d: haversineKm(anchor!.lat, anchor!.lon, a.lat, a.lon) }))
			.filter((x) => x.d <= gateKm)
			.sort((x, y) => x.d - y.d)[0]
		if (reconciling) {
			// Swap to the consistent instance; the displaced winner becomes an alternative.
			const displaced: ResolvedPlace = {
				id: 0,
				name: String(node.metadata?.["resolver_name"] ?? node.value),
				placetype: "locality",
				country: reconciling.a.country,
				lat: node.lat!,
				lon: node.lon!,
				score: 0,
			}
			const rest = alts.filter((a) => a !== reconciling.a)
			decorateNode(node, reconciling.a, [displaced, ...rest])
			node.metadata = { ...(node.metadata ?? {}), postcode_repicked: true }
			continue
		}
		// No same-named instance near the postcode → the town is unreliable; trust the postcode's area.
		node.lat = anchor.lat
		node.lon = anchor.lon
		node.metadata = { ...(node.metadata ?? {}), postcode_city_mismatch: true, coordinate_source: "postcode_fallback" }
	}
}

class WofResolver implements Resolver {
	readonly #backend: ResolverBackend

	constructor(backend: ResolverBackend) {
		this.#backend = backend
	}

	async resolveTree(tree: AddressTree, opts: ResolveOpts = {}): Promise<AddressTree> {
		const state: ResolutionState = {
			lookupsRemaining: opts.maxLookups ?? 10,
			// Full replacement when `placetypeMap` is supplied — callers that want to extend rather
			// than replace should spread DEFAULT_PLACETYPE_MAP themselves.
			placetypeMap: opts.placetypeMap ?? DEFAULT_PLACETYPE_MAP,
			minWinningScore: opts.minWinningScore ?? 0,
			candidatesPerLookup: opts.candidatesPerLookup ?? 5,
			defaultCountry: opts.defaultCountry,
			parentFallback: opts.parentFallback ?? true,
			postcode: firstPostcodeValue(tree.roots),
			anchorPosterior: opts.anchorPosterior,
			anchorWeight: opts.anchorWeight ?? 2.0,
			hardCountry: opts.hardCountry,
			// Default-ON (#402): completion only fires for a dual-role region whose locality the parser
			// dropped, and no-ops entirely when the backend has no relation (the browser WASM resolver, or
			// a gazetteer without `coincident_roles`). Pass `hierarchyCompletion: false` to opt out.
			// `cityStateFallback` is the #387 alias that #405 generalized — still honored.
			hierarchyCompletion: opts.hierarchyCompletion ?? opts.cityStateFallback ?? true,
			includeAncestors: opts.includeAncestors ?? false,
			localityNodePresent: false,
			resolvedRegion: null,
			resolvedRegionNode: null,
		}

		const newRoots: AddressNode[] = []
		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}

		// Dual-role hierarchy completion (#405/#415). Only when enabled, a region resolved, and the parser
		// emitted NO locality — record the dropped locality as a SECONDARY ROLE (an interpretation) on the
		// resolved region node, from the backend's precomputed coincident-roles relation (#403). One node,
		// one span, two roles — no synthesized sibling. See ResolveOpts.hierarchyCompletion.
		if (state.hierarchyCompletion && state.resolvedRegion && state.resolvedRegionNode && !state.localityNodePresent) {
			this.#completeRegionRole(state.resolvedRegion, state.resolvedRegionNode)
		}

		// Postcode-consistency (#370 "Lever A"): opt-in. After the admin walk (needs both the locality
		// and the postcode resolved) and before the street tiers (which key off the postcode/street, not
		// the locality coordinate this adjusts). Byte-stable when opts.postcodeConsistency is unset.
		if (opts.postcodeConsistency) {
			applyPostcodeConsistency(newRoots, opts.postcodeConsistencyGateKm ?? 50)
		}
		// Address-point tier (#476): opt-in street-level exact match. After the admin walk so the
		// tier can never disturb admin attribution — it only ADDS the precise coordinate. Byte-stable
		// when opts.addressPoints is absent.
		if (opts.addressPoints) {
			applyAddressPoint(newRoots, opts.addressPoints)
		}
		// Interpolation tier (#483): strictly AFTER the exact-point block so an estimate can never
		// override a real situs point (applyInterpolation also gates on resolution_tier). Opt-in;
		// byte-stable when opts.interpolation is absent.
		if (opts.interpolation) {
			applyInterpolation(newRoots, opts.interpolation, opts.interpolationRadiusCalibration)
		}
		// Span-rescore tier (#370): opt-in, last (so it only fires when every other tier left the tree
		// unresolved). Byte-stable when opts.spanRescore is unset.
		if (opts.spanRescore) {
			await applySpanRescore(newRoots, tree.raw, this.#backend, opts)
		}
		return { raw: tree.raw, roots: newRoots }
	}

	/**
	 * Record a dropped dual-role locality as a `locality` INTERPRETATION on the resolved region node
	 * (#415, generalizes #405's synthesized node). Consults `coincidentLocalitiesFor(regionId)` (O(1)
	 * map lookup — no distance math, no backend query), picks the principal city
	 * ({@link pickCompletion}: population-primary, distance tiebreak, abstain on a genuine tie), and
	 * appends an interpretation to `regionNode.interpretations`. No-op when the backend has no
	 * relation, the region isn't a dual-role place, or it abstains. The region node's primary role
	 * stays `region`; the locality rides alongside.
	 */
	#completeRegionRole(region: ResolvedPlace, regionNode: AddressNode): void {
		if (typeof region.id !== "number" || !this.#backend.coincidentLocalitiesFor) return
		const loc = pickCompletion(this.#backend.coincidentLocalitiesFor(region.id))
		if (!loc) return
		const interpretation: Interpretation = {
			tag: "locality",
			placeId: `wof:${loc.id}`,
			sourceId: `${loc.placetype}:${loc.id}`,
			lat: loc.lat,
			lon: loc.lon,
			confidence: 0,
			metadata: { relationship_type: loc.relationshipType, resolver_completed: true, resolver_name: loc.name },
		}
		regionNode.interpretations = [...(regionNode.interpretations ?? []), interpretation]
	}

	async #walk(node: AddressNode, parentResolved: ResolvedPlace | null, state: ResolutionState): Promise<AddressNode> {
		// Always clone — never mutate input nodes.
		const decorated: AddressNode = { ...node, children: [] }

		const placetype = state.placetypeMap[node.tag as ComponentTag]
		// Track locality presence for hierarchy completion (#405): completion must NOT fire if the parser
		// already emitted a locality node (even one that failed to resolve) — it only fills a genuine
		// gap. Cheap and always-on; only consulted when hierarchyCompletion is set.
		if (placetype === "locality") state.localityNodePresent = true
		let resolved: ResolvedPlace | null = null
		if (placetype && state.lookupsRemaining > 0 && node.value.trim().length > 0) {
			const picked = await this.#lookupAndPick(node, placetype, parentResolved, state)
			if (picked) {
				resolved = picked.top
				decorateNode(decorated, picked.top, picked.alternatives)
				// Lineage attachment (#404): stamp the resolved place's ancestor chain onto metadata. Opt-in
				// + only when the backend supplies it, so the default stays byte-identical (no extra query).
				if (state.includeAncestors && this.#backend.ancestors) {
					decorated.metadata = { ...(decorated.metadata ?? {}), ancestors: this.#backend.ancestors(picked.top.id) }
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

	async #lookupAndPick(
		node: AddressNode,
		placetype: string,
		parentResolved: ResolvedPlace | null,
		state: ResolutionState
	): Promise<{ top: ResolvedPlace; alternatives: ResolvedPlace[] } | null> {
		state.lookupsRemaining--

		const query: Parameters<ResolverBackend["findPlace"]>[0] = {
			text: node.value,
			placetype,
			limit: state.candidatesPerLookup,
		}
		// Pass the inherited parent constraint to the backend when available — `parentId` scopes to
		// the resolved parent's descendants. For `country`: a resolved parent's country wins, else
		// fall back to the caller's `defaultCountry`. Without this top-level hint a bare "IL" over a
		// multi-country gazetteer fuzzy-matches a foreign place (e.g. a French region) — see the
		// Direction-C resolver eval.
		if (parentResolved && typeof parentResolved.id === "number") query.parentId = parentResolved.id
		// #194: a resolved parent's country wins, then the caller's `defaultCountry`, then the confident
		// placer `hardCountry`. All three are a HARD candidate filter. The placer's `hardCountry` is gated
		// upstream on high confidence (so it only fires when the model is sure), and on a miss the node is
		// left UNRESOLVED rather than re-resolved globally: the off-continent rows are precisely the ones
		// whose locality isn't in the country's gazetteer slice, so a global retry would just re-admit the
		// wrong-continent guess the hard filter exists to drop ("in-region or unresolved"). Measured: a
		// global fallback collapses back to the soft-prior baseline (FI p90 3050, PL p90 1078); pure-hard
		// collapses the tail (FI 18 km, PL p99 8172→494) at a coverage-bounded recall cost.
		const country = parentResolved?.country ?? state.defaultCountry ?? state.hardCountry
		if (country) query.country = country
		// Coordinate-first: hand the sibling postcode to locality lookups so the backend can inject
		// postcode-proximal candidates the name-match would miss. Only for locality (the placetype both
		// `locality` and `dependent_locality` map to); other placetypes ignore it.
		if (placetype === "locality" && state.postcode) query.postcode = state.postcode

		let candidates: ResolvedPlace[]
		try {
			candidates = await this.#backend.findPlace(query)
			// Parent soft-gating: `parentId` is a HARD descendant filter in the backend, which wrongly
			// zeroes the result when the parent resolved wrong OR the gazetteer hierarchy is incomplete
			// (a real locality whose `ancestors` chain is missing its region). Rather than turn a
			// resolvable node into an unresolved one, retry once WITHOUT the parent constraint — we
			// prefer a parent-scoped hit but never sacrifice recall. The country constraint is kept, so
			// this still can't wander to a foreign place. Same logical resolution → no extra budget.
			if (candidates.length === 0 && state.parentFallback && query.parentId !== undefined) {
				delete query.parentId
				candidates = await this.#backend.findPlace(query)
			}
		} catch {
			// Defensive: a backend failure should not abort the whole tree walk. Leave the node with
			// its classifier attribution intact.
			return null
		}

		if (candidates.length === 0) return null
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
		// excluded: they don't exhibit this collision class and carry country via `parentId` when nested.)
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
			ranked = [...candidates].sort(
				(a, b) =>
					Number(b.exactMatch ?? false) - Number(a.exactMatch ?? false) ||
					b.score + w * (post[b.country] ?? 0) - (a.score + w * (post[a.country] ?? 0))
			)
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
		}

		const top = ranked[0]!
		if (top.score < state.minWinningScore) return null
		// Fallback-observability (#718): if the winner is a macro-type AND no exact-type candidate
		// existed for this span, annotate that a broader tier stood in for the true one. Additive —
		// identity/coordinate are unchanged; only `metadata.resolution_quality` is stamped downstream.
		if (isPlacetypeFallback(placetype, top.placetype)) {
			top.resolutionQuality = "fallback"
		}
		return { top, alternatives: ranked.slice(1) }
	}
}

/**
 * Stamp a node with resolver-supplied attribution. Displaces any prior classifier `source` /
 * `sourceId` into `metadata.classifier_source` / `metadata.classifier_source_id` so debugging tools
 * can still see who made the original assertion. Surfaces the runner-up candidates on
 * `alternatives` so callers can disambiguate (Springfield-class failures, [#8 in the failure
 * catalogue]).
 */
function decorateNode(node: AddressNode, resolved: ResolvedPlace, alternatives: ResolvedPlace[]): void {
	if (node.source !== undefined || node.sourceId !== undefined) {
		const meta = { ...(node.metadata ?? {}) }
		if (node.source !== undefined) meta["classifier_source"] = node.source
		if (node.sourceId !== undefined) meta["classifier_source_id"] = node.sourceId
		node.metadata = meta
	}
	node.source = "resolver"
	node.sourceId = `${resolved.placetype}:${resolved.id}`
	node.lat = resolved.lat
	node.lon = resolved.lon
	node.placeId = `wof:${resolved.id}` // v1: only WOF resolvers; the URI scheme stays this simple
	// Record the resolver's ranking score AND the resolved place's CANONICAL name. The name is the
	// gazetteer's truth for the place we picked — distinct from `node.value` (the raw input span). It
	// lets consumers display the canonical name and lets the end-to-end eval check the resolver chose
	// the right PLACE (gazetteer-name vs ground-truth) rather than merely echoing the parser's text.
	node.metadata = { ...(node.metadata ?? {}), resolver_score: resolved.score, resolver_name: resolved.name }
	// The postcode/locality conflict flag (the falsehood differentiator): the postcode pointed to a
	// geographically different place than the parsed city name. Surface it so callers can warn rather
	// than silently trust the resolved point.
	if (resolved.mismatch) node.metadata["postcode_city_mismatch"] = true
	// Fallback-observability (#718): a broader admin tier (macroregion/macrocounty) stood in for the
	// true region/county because no exact-type candidate existed. Additive annotation only — the
	// resolved coordinate/identity above is untouched; this just lets a consumer / QA pass see it.
	if (resolved.resolutionQuality) node.metadata["resolution_quality"] = resolved.resolutionQuality
	if (alternatives.length > 0) {
		node.alternatives = alternatives
	}
}
