/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bare-toponym street-miss fallback, split from `geocode-core.ts` (the max-lines cap; the
 *   geocode file holds the cascade, this one holds the retry). Contract in {@link applyStreetMissFallback}.
 */

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import { loneValueBearingNode } from "@mailwoman/core/decoder"
import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts } from "@mailwoman/core/resolver"

/**
 * Retry a lone street-tagged token as a locality only after a null result and when no fork is declared. The retry omits
 * inferred country constraints but preserves an explicit default country.
 */
export async function applyStreetMissFallback(
	result: GeocodeOutcomeLike,
	ctx: {
		tree: AddressTree
		opts: ResolveOpts
		/**
		 * The subset of GeocodeDeps this retry reads — structural, so this module needs no geocode-core import (the
		 * no-cycle rule; `extract` is injected for the same reason).
		 */
		deps: {
			resolver?: { resolveTree(tree: AddressTree, opts: ResolveOpts): Promise<AddressTree> }
			defaultCountryIsInferred?: boolean
		}
		input: string
		forkDeclared: boolean
		extract: (input: string, tree: AddressTree) => GeocodeOutcomeLike
	}
): Promise<GeocodeOutcomeLike> {
	const { tree, opts, deps, input, forkDeclared, extract } = ctx

	if (result.lat !== null || !deps.resolver || forkDeclared) return result
	const bare = loneBareStreetSpan(tree)

	if (bare === null || /\s/.test(bare.trim())) return result

	const localityTree: AddressTree = {
		raw: tree.raw,
		roots: [{ tag: "locality", value: bare, start: 0, end: bare.length, confidence: 1, children: [] }],
	}

	const retryOpts = {
		...opts,
		hardCountry: undefined,
		anchorPosterior: undefined,
		...(deps.defaultCountryIsInferred === true ? { defaultCountry: undefined } : {}),
	}

	const reresolved = await deps.resolver.resolveTree(localityTree, retryOpts)
	const retried = extract(input, reresolved)

	if (retried.lat === null) return result
	retried.components = { ...result.components }

	return retried
}

/**
 * The lone bare street span the street-miss fallback retries as a locality, or `null` when the tree is anything richer:
 * the check is exactly one value-bearing node, tagged `street`, no prefix/suffix siblings — the single-token shape the
 * model mis-tags on unfamiliar capitals.
 */
function loneBareStreetSpan(tree: AddressTree): string | null {
	const lone = loneValueBearingNode(tree)

	return lone?.tag === "street" ? lone.value : null
}
