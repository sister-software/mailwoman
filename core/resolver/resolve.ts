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

import type { AddressNode, AddressTree, ComponentTag } from "../decoder/types.js"
import {
	type CoincidentLocality,
	DEFAULT_PLACETYPE_MAP,
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
	/** Dual-role hierarchy completion (#405). Off by default → byte-stable. */
	hierarchyCompletion: boolean
	/**
	 * Set while resolving when ANY tree node maps to the `locality` placetype (resolved or not) — the
	 * completion only fires when the parser emitted no locality at all, never to override one.
	 */
	localityNodePresent: boolean
	/** The first region that resolved, captured for the post-walk city-state recovery. */
	resolvedRegion: ResolvedPlace | null
	/**
	 * The span of the region node that produced {@link resolvedRegion}, reused for the synthesized
	 * locality (which has no span of its own in the raw input).
	 */
	resolvedRegionSpan: { start: number; end: number } | null
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
			// `cityStateFallback` is the #387 alias that #405 generalized — still honored.
			hierarchyCompletion: opts.hierarchyCompletion ?? opts.cityStateFallback ?? false,
			localityNodePresent: false,
			resolvedRegion: null,
			resolvedRegionSpan: null,
		}

		const newRoots: AddressNode[] = []
		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}

		// Dual-role hierarchy completion (#405). Only when enabled, a region resolved, and the parser
		// emitted NO locality — synthesize the locality from the backend's precomputed coincident-roles
		// relation (#403). See ResolveOpts.hierarchyCompletion for the rationale + disambiguation rule.
		if (state.hierarchyCompletion && state.resolvedRegion && !state.localityNodePresent) {
			const synthesized = this.#completeFromRelation(state)
			if (synthesized) newRoots.push(synthesized)
		}
		return { raw: tree.raw, roots: newRoots }
	}

	/**
	 * Complete a dropped dual-role locality from the backend's coincident-roles relation (#403/#405).
	 * Consults `coincidentLocalitiesFor(regionId)` (O(1) map lookup — no distance math, no backend
	 * query), picks the principal city ({@link pickCompletion}: population-primary, distance tiebreak,
	 * abstain on a genuine tie), and builds a synthesized locality node borrowing the region's span.
	 * Returns null when the backend has no relation, the region isn't a dual-role place, or it
	 * abstains. Marked `metadata.resolver_synthesized` + `metadata.relationship_type`.
	 */
	#completeFromRelation(state: ResolutionState): AddressNode | null {
		const region = state.resolvedRegion!
		if (typeof region.id !== "number" || !this.#backend.coincidentLocalitiesFor) return null
		const loc = pickCompletion(this.#backend.coincidentLocalitiesFor(region.id))
		if (!loc) return null
		const span = state.resolvedRegionSpan ?? { start: 0, end: 0 }
		const synthesized: AddressNode = {
			tag: "locality",
			value: loc.name,
			start: span.start,
			end: span.end,
			confidence: 0,
			children: [],
		}
		decorateNode(synthesized, loc, [])
		synthesized.metadata = {
			...(synthesized.metadata ?? {}),
			resolver_synthesized: true,
			relationship_type: loc.relationshipType,
		}
		return synthesized
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
				// Capture the first resolved region for the city-state recovery, along with its span so
				// the synthesized locality can borrow it (it has no span of its own).
				if (placetype === "region" && state.resolvedRegion === null) {
					state.resolvedRegion = picked.top
					state.resolvedRegionSpan = { start: node.start, end: node.end }
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
		const country = parentResolved?.country ?? state.defaultCountry
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
		// undefined (the default) → byte-identical resolution. Locality-scoped: the posterior is a country
		// signal, and admin parents already carry country via `parentId`.
		let ranked = candidates
		if (state.anchorPosterior && placetype === "locality" && candidates.length > 1) {
			const post = state.anchorPosterior
			const w = state.anchorWeight
			ranked = [...candidates].sort(
				(a, b) => b.score + w * (post[b.country] ?? 0) - (a.score + w * (post[a.country] ?? 0))
			)
		}
		const top = ranked[0]!
		if (top.score < state.minWinningScore) return null
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
	if (alternatives.length > 0) {
		node.alternatives = alternatives
	}
}
