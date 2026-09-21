/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #727 stage-2 Phase 4a — reranking a k-best parse list on resolution evidence.
 *
 *   The arc's thesis, stated by the operator (2026-07-15): the arbiter for a k-best list is the
 *   resolver rather than hand-weights. A rank-2 parse that resolves to a real place beats a rank-1 that
 *   resolves to a country centroid.
 *
 *   The measured case for this existing at all: on the triaged parity corpus the shipped decode gets
 *   street 0.573 while the span decode's top-10 contains the right answer 0.775 of the time
 *   (oracle@5 0.723). Rank-1 cannot reach that headroom. only a reranker can.
 *
 *   ## Why this is deliberately, almost embarrassingly small
 *
 *   The failure mode we are avoiding is Pelias's: a ladder of per-class hand-tuned weights that
 *   nobody can re-derive (see `docs/articles/evals/competitive-parity/2026-07-15-pelias-dictionary-overrides.md`
 *   — 94 of 276 dictionary lines are hand-written deletions, each resolving a collision in favour of
 *   whoever complained loudest). The moment this file grows a per-hypothesis score blend, we have
 *   rebuilt that with extra steps.
 *
 *   So the rule is one bit of evidence rather than a score: **drop hypotheses whose resolution is
 *   implausible. otherwise keep the model's own ranking.** The parse scores already share a partition
 *   function and are comparable within an input — the reranker's job is not to re-score them, it is to
 *   veto the ones the world says are wrong.
 *
 *   Adding a second signal here requires the same bar the first one cleared: a measured win on the
 *   parity + Paris fixtures, stated in a verdict doc. Not a plausible story.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { CountryBBoxFact } from "@mailwoman/core/resolver"

import { isImplausibleResolution } from "#plausibility"

/**
 * One candidate parse from the k-best decode, with its (within-input comparable) score.
 */
export interface RerankCandidate<T = unknown> {
	/**
	 * The parse's own score.
	 *
	 * Comparable to its siblings from the same input.
	 * Not across inputs.
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
	 * True when the winner is not the model's rank-1 — i.e. resolution evidence actually changed the answer.
	 *
	 * This is the metric the arc is judged on (`rank-2-beats-rank-1 rate`); log it,
	 * because a rerank that never fires is a rerank that is not earning its resolver calls.
	 */
	changed: boolean
}

/**
 * Resolve a tree.
 *
 * Structural — any `Resolver`-shaped thing satisfies it.
 */
export type ResolveTree = (tree: AddressTree) => Promise<AddressTree>

export interface RerankOpts {
	/**
	 * Resolve at most this many candidates (default 5).
	 *
	 * Each costs a resolver round-trip, so this is the latency knob. oracle@5 (0.723) captures
	 * nearly all the measured headroom of oracle@10 (0.775), so 5 is the default rather than 10.
	 * The last 5 candidates cost 2x the resolves for ~5pp of ceiling.
	 */
	maxResolve?: number
	/**
	 * ISO-2 country the resolutions are expected to land in — the parse's own country node,
	 * the `--locale` scope, or a caller hint.
	 *
	 * Threaded to {@link isImplausibleResolution} as guard B: a coordinate outside that country's
	 * coarse box is vetoed, which is the cross-country-jump class guard A structurally cannot see.
	 *
	 * Omitted → guard B does not run, and only the bare-country-centroid guard applies.
	 * That is the shipped default and it changes nothing on the served path, because
	 * nothing on the served path calls this function: the runtime pipeline reranks with
	 * `rerankByStreetEvidence`, and this one has no in-repo caller outside its own test.
	 */
	expectedCountry?: string
	/**
	 * The loaded artifact's own guard-B boxes (`resolver.artifactCoverage?.countryBBoxes`).
	 *
	 * Replaces the built-in table wholesale when supplied, so a consumer's artifact
	 * and its guard cannot disagree.
	 */
	countryBBoxes?: ReadonlyMap<string, CountryBBoxFact>
}

/**
 * Rerank a k-best parse list on resolution evidence.
 *
 * Resolves up to `maxResolve` candidates IN model order and returns the first whose resolution is plausible.
 * Candidates beyond `maxResolve` are never resolved
 * (and never vetoed — they simply keep their model rank behind the resolved ones).
 *
 * **When every resolved candidate is implausible, the model's rank-1 wins.** A reranker that returns
 * nothing is worse than one that defers: "all my evidence says these are all bad" is not grounds to
 * invent a different answer, only grounds to flag low confidence (the Phase-4b ambiguity check).
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
			// Beyond the resolve budget: carried through unresolved, never vetoed.
			ranked.push({ ...candidate, resolved: null, implausible: false })

			continue
		}

		let resolved: AddressTree | null

		try {
			resolved = await resolveTree(candidate.tree)
		} catch {
			// A resolver failure is not evidence against the parse — treat it as "no evidence" and let
			// the model's rank stand, rather than vetoing a possibly-correct hypothesis on an outage.
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

	// Stable partition: plausible first (model order preserved within each group), vetoed after.
	const plausible = ranked.filter((r) => !r.implausible)
	const vetoed = ranked.filter((r) => r.implausible)
	const finalOrder = [...plausible, ...vetoed]
	const best = finalOrder[0]!

	return { ranked: finalOrder, best, changed: best !== ranked[0] }
}
