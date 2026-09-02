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
 * The bare-toponym STREET-MISS fallback (the Moscow/Wellington/Antwerpen class): the model tags a lone bare token
 * `street`, the street tier finds no such street, and the result is null — while the resolver walk, handed the same
 * span as a locality, answers directly. Four checks: null-only (the D-rule geometry the fork wire established); a lone
 * SINGLE-TOKEN street-tagged span (a multi-token retry re-enters the qualifier-strip scrape class — measured: the
 * unguarded retry stripped 'COMER parís.méxico' to Comer, Georgia); never on a declared fork (those belong to the
 * entity probe); and the retry runs under the #912 bare-locality posture — placer anchor/hard filter always withheld
 * (measured: keeping them handed bare 'Wellington' to the GB namesake, 18,726 km out), an INFERRED default country
 * withheld too, an explicit one supreme.
 */
export async function applyStreetMissFallback(
	result: GeocodeOutcomeLike,
	ctx: {
		tree: AddressTree
		opts: ResolveOpts
		/**
		 * The slice of GeocodeDeps this retry reads — structural, so this module needs no geocode-core import (the no-cycle
		 * rule; `extract` is injected for the same reason).
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
 * the check is EXACTLY one value-bearing node, tagged `street`, no prefix/suffix siblings — the single-token shape the
 * model mis-tags on unfamiliar capitals.
 */
function loneBareStreetSpan(tree: AddressTree): string | null {
	const lone = loneValueBearingNode(tree)

	return lone?.tag === "street" ? lone.value : null
}
