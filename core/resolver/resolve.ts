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
		}

		const newRoots: AddressNode[] = []
		for (const root of tree.roots) {
			newRoots.push(await this.#walk(root, /* parentResolved */ null, state))
		}
		return { raw: tree.raw, roots: newRoots }
	}

	async #walk(node: AddressNode, parentResolved: ResolvedPlace | null, state: ResolutionState): Promise<AddressNode> {
		// Always clone — never mutate input nodes.
		const decorated: AddressNode = { ...node, children: [] }

		const placetype = state.placetypeMap[node.tag as ComponentTag]
		let resolved: ResolvedPlace | null = null
		if (placetype && state.lookupsRemaining > 0 && node.value.trim().length > 0) {
			const picked = await this.#lookupAndPick(node, placetype, parentResolved, state)
			if (picked) {
				resolved = picked.top
				decorateNode(decorated, picked.top, picked.alternatives)
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
		// Pass the inherited parent constraint to the backend when available — both `parentId` and
		// `country` are valid narrowing hints depending on what the parent resolved to.
		if (parentResolved) {
			if (typeof parentResolved.id === "number") query.parentId = parentResolved.id
			if (parentResolved.country) query.country = parentResolved.country
		}

		let candidates: ResolvedPlace[]
		try {
			candidates = await this.#backend.findPlace(query)
		} catch {
			// Defensive: a backend failure should not abort the whole tree walk. Leave the node with
			// its classifier attribution intact.
			return null
		}

		if (candidates.length === 0) return null
		const top = candidates[0]!
		if (top.score < state.minWinningScore) return null
		return { top, alternatives: candidates.slice(1) }
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
	if (alternatives.length > 0) {
		node.alternatives = alternatives
	}
}
