/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Rerank a k-best parse list on resolution evidence with one bit — drop hypotheses whose resolution
 *   is implausible, otherwise keep the model's own ranking — because a second signal here needs a
 *   measured win on the parity + Paris fixtures.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { CountryBBoxFact } from "@mailwoman/core/resolver"

import { isImplausibleResolution } from "#plausibility"

/**
 * One candidate parse from the k-best decode, with its (within-input comparable) score.
 */
export interface RerankCandidate<T = unknown> {
	/**
	 * The parse's own score, comparable to its siblings from the same input and not across inputs.
	 */
	score: number
	/**
	 * The parse tree, unresolved — `rerankByResolution` resolves it via the injected resolver.
	 */
	tree: AddressTree
	/**
	 * Opaque caller payload carried through to the result (the segmentation, a surface string, …).
	 */
	payload?: T
}

export interface RerankedCandidate<T = unknown> extends RerankCandidate<T> {
	/**
	 * The resolved tree (the resolver's output), or null when resolution threw.
	 */
	resolved: AddressTree | null
	/**
	 * True when the resolution is implausible (today: resolves no finer than a country centroid).
	 */
	implausible: boolean
	/**
	 * Why it was vetoed, when it was.
	 */
	reason?: string
}

export interface RerankResult<T = unknown> {
	/**
	 * Candidates in final order: plausible ones first (model order preserved), vetoed ones after.
	 */
	ranked: Array<RerankedCandidate<T>>
	/**
	 * The winner — the first plausible candidate, or the model's rank-1 when all were vetoed.
	 */
	best: RerankedCandidate<T>
	/**
	 * True when resolution evidence actually changed the answer from the model's rank-1.
	 */
	changed: boolean
}

/**
 * Resolve a tree; structural, so any `Resolver`-shaped thing satisfies it.
 */
export type ResolveTree = (tree: AddressTree) => Promise<AddressTree>

export interface RerankOpts {
	/**
	 * Resolve at most this many candidates (default 5); each costs a resolver round-trip,
	 * so this is the latency knob.
	 */
	maxResolve?: number
	/**
	 * ISO-2 country the resolutions are expected to land in, threaded to
	 * {@link isImplausibleResolution} as guard B so a coordinate outside that country's
	 * coarse box is vetoed; omitted, only the bare-country-centroid guard runs.
	 */
	expectedCountry?: string
	/**
	 * The loaded artifact's own guard-B boxes, replacing the built-in table wholesale when supplied.
	 */
	countryBBoxes?: ReadonlyMap<string, CountryBBoxFact>
}

/**
 * Rerank a k-best parse list on resolution evidence: resolve up to `maxResolve` candidates in model
 * order and return the first plausible one; candidates beyond `maxResolve` are never resolved
 * and never vetoed, and when every resolved candidate is implausible the model's rank-1 wins.
 */
export async function rerankByResolution<T>(
	candidates: ReadonlyArray<RerankCandidate<T>>,
	resolveTree: ResolveTree,
	opts: RerankOpts = {}
): Promise<RerankResult<T>> {
	if (!candidates.length) throw new Error("rerankByResolution: candidates must not be empty")
	const maxResolve = Math.max(1, Math.min(opts.maxResolve ?? 5, candidates.length))
	const ranked: Array<RerankedCandidate<T>> = []

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]!

		if (i >= maxResolve) {
			ranked.push({ ...candidate, resolved: null, implausible: false })

			continue
		}

		let resolved: AddressTree | null

		try {
			resolved = await resolveTree(candidate.tree)
		} catch {
			// A resolver failure is not evidence against the parse, so the model's rank stands
			// rather than vetoing a possibly-correct hypothesis on an outage.
			ranked.push({ ...candidate, resolved: null, implausible: false })

			continue
		}

		const verdict = isImplausibleResolution(resolved, {
			...(opts.expectedCountry ? { expectedCountry: opts.expectedCountry } : {}),
			...(opts.countryBBoxes ? { countryBBoxes: opts.countryBBoxes } : {}),
		})

		ranked.push({
			...candidate,
			resolved,
			implausible: verdict.implausible,
			...(verdict.reason ? { reason: verdict.reason } : {}),
		})
	}

	const plausible = ranked.filter((r) => !r.implausible)
	const vetoed = ranked.filter((r) => r.implausible)
	const finalOrder = [...plausible, ...vetoed]
	const best = finalOrder[0]!

	return { ranked: finalOrder, best, changed: best !== ranked[0] }
}
