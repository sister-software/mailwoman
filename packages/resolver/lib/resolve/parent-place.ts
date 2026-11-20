// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The caller's parent place: reading it from the backend, and the lineage test a hard parent applies.
 */

import {
	type ParentPlaceScope,
	type ResolvedPlace,
	type ResolverBackend,
	ScopeStrength,
} from "@mailwoman/core/resolver"

import type { ResolutionState, ResolvedParentPlace } from "#resolve/passes"

/**
 * Applies the country of the caller's parent place: a hard parent's as a caller default
 * country, a soft parent's as the soft scope when no hard scope is set.
 *
 * It throws when a hard parent lies outside the caller's default country.
 */
export function applyParentPlaceCountry(state: ResolutionState): void {
	const parent = state.parentPlace

	if (!parent) return

	const country = parent.place.country!.toUpperCase()

	if (parent.scope.strength === ScopeStrength.Hard) {
		const stated = state.defaultCountry

		if (stated?.source === "caller" && stated.country.toUpperCase() !== country) {
			throw new Error(
				`parent place ${parent.scope.id} (${parent.place.name}) lies in ${country}, outside the default country ${stated.country}`
			)
		}

		state.defaultCountry = { country, source: parent.scope.source }
		state.softCountry = null

		return
	}

	if (!state.defaultCountry) {
		state.softCountry = { country, source: parent.scope.source, strength: ScopeStrength.Soft }
	}
}

/**
 * Passes the caller's parent place as the containment qualifier of a lookup the
 * walk's own parent doesn't qualify, and reports whether it did.
 */
export function applyCallerParentQualifier(
	query: Parameters<ResolverBackend["findPlace"]>[0],
	state: Pick<ResolutionState, "parentPlace">
): boolean {
	if (!state.parentPlace || query.parentQualifierID != null) return false

	query.parentQualifierID = state.parentPlace.scope.id

	return true
}

/**
 * Reads the parent place's record and its ancestors' ids.
 *
 * It throws when the backend can't look a place up by id or read lineage,
 * when the gazetteer holds no place with the id, or when the place has no country,
 * because a scope it can't apply would answer as if the caller had set none.
 */
export function readParentPlace(backend: ResolverBackend, scope: ParentPlaceScope): ResolvedParentPlace {
	if (!backend.place || !backend.ancestors) {
		throw new Error(`parent place ${scope.id}: the resolver backend can't look up a place by id and its lineage`)
	}

	const place = backend.place(scope.id)

	if (!place) throw new Error(`parent place ${scope.id}: the gazetteer holds no place with this id`)

	if (!place.country) throw new Error(`parent place ${scope.id} (${place.name}): the gazetteer records no country`)

	const ancestorIDs = new Set(backend.ancestors(scope.id).map((ancestor) => Number(ancestor.id)))

	return { scope, place, ancestorIDs }
}

/**
 * Whether a candidate agrees with the parent's lineage: it is the parent,
 * lies inside it, or is one of its ancestors.
 *
 * When the lookup's containment qualifier was the parent, a candidate the backend
 * marked contained needs no lineage read.
 */
export function agreesWithParent(
	candidate: Pick<ResolvedPlace, "id" | "containedByQualifier">,
	parent: ResolvedParentPlace,
	ancestors: NonNullable<ResolverBackend["ancestors"]>,
	qualifierIsParent: boolean
): boolean {
	const id = Number(candidate.id)
	const parentID = parent.scope.id

	if (qualifierIsParent && candidate.containedByQualifier === true) return true

	if (id === parentID || parent.ancestorIDs.has(id)) return true

	return ancestors(candidate.id).some((ancestor) => Number(ancestor.id) === parentID)
}
