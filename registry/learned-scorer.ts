/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The learned scorer (#603) — the production wiring for the gradient-boosted-tree model behind
 *   {@link ResolveConfig.scorer}. Two pieces:
 *
 *   1. {@link createMatchFeaturizer} — the ONE feature extractor for a candidate pair, used identically
 *        at train time (`scripts/eval/record-matcher/train-gbt.ts`), eval time (the learned-scorer
 *        evals), and inference time (here). A pair → one-hot of each comparison's agreement level +
 *        the over-merge interaction terms (co-located × name/org disagreement) + address
 *        crowdedness.
 *   2. {@link createGbtScorer} — wraps a trained {@link GBT} + the featurizer into the `(a, b) => number`
 *        the resolve pipeline's `scorer` hook expects (a logit, threshold-comparable with the
 *        Fellegi-Sunter weight it replaces).
 *
 *   Both take the comparison set as INPUT (rather than importing {@link buildDefaultModel}) so this
 *   module has no dependency cycle with `resolve.ts`. The contract that keeps train ≡ inference:
 *   feed the comparisons from `buildDefaultModel({ collapseSpatial: true, addressFrequency })` —
 *   the model's structure (and thus the feature layout) is fixed by that config; only the frequency
 *   VALUES differ between the training corpus and the matched set, which is the point (the model
 *   generalizes, as the cross-state eval showed).
 */

import {
	agreementPattern,
	type Comparison,
	type GBT,
	gbtScore,
	nameSimilarity,
	type TermFrequencyTable,
} from "@mailwoman/match"

import type { SourceRecord } from "./types.ts"

/** Inputs shared by the featurizer + the scorer factory. */
export interface LearnedFeatureConfig {
	/**
	 * The comparison set the features are built over — MUST be `buildDefaultModel({ collapseSpatial: true,
	 * addressFrequency }).comparisons` so the feature layout matches the trained model. (`usePhone` / `discriminators`
	 * are NOT part of the learned feature model — the GBT replaces the FS weight wholesale and owns its own feature
	 * vector.)
	 */
	comparisons: Comparison<SourceRecord>[]
	/**
	 * Address-frequency table for the crowdedness feature (a crowded shared address is weak identity).
	 */
	addressFrequency: TermFrequencyTable
}

/**
 * Build the per-pair feature extractor. The vector is: one-hot of each comparison's agreement level, then the two
 * over-merge interaction terms (spatial-exact × name-disagree, spatial-exact × org-disagree — the "same place,
 * different names" signature that drives co-located over-merges), then address crowdedness scaled into [0, 1].
 * Deterministic and EM-independent, so it is identical across train / eval / inference.
 */
export function createMatchFeaturizer(config: LearnedFeatureConfig): (a: SourceRecord, b: SourceRecord) => number[] {
	const { comparisons, addressFrequency } = config
	const levelCounts = comparisons.map((c) => c.levels.length)
	const index = Object.fromEntries(comparisons.map((c, i) => [c.name, i])) as Record<string, number | undefined>
	const spatialI = index["spatial"]
	const givenI = index["given"]
	const familyI = index["family"]
	const orgI = index["organization"]
	const lastLevel = (i: number): number => levelCounts[i]! - 1

	return (a, b) => {
		const pat = agreementPattern(comparisons, a, b)
		const f: number[] = []

		for (let i = 0; i < pat.length; i++) {
			const lvl = pat[i]!

			for (let l = 0; l < levelCounts[i]!; l++) {
				f.push(lvl === l ? 1 : 0)
			}
		}
		// Interaction: co-located (spatial exact = level 0) AND names/org disagree (catch-all level).
		const spatialExact = spatialI !== undefined && pat[spatialI] === 0 ? 1 : 0
		const nameDisagree =
			givenI !== undefined &&
			familyI !== undefined &&
			pat[givenI] === lastLevel(givenI) &&
			pat[familyI] === lastLevel(familyI)
				? 1
				: 0
		const orgDisagree = orgI !== undefined && pat[orgI] === lastLevel(orgI) ? 1 : 0
		f.push(spatialExact * nameDisagree) // the over-merge signature: same place, names disagree
		f.push(spatialExact * orgDisagree)
		// Address crowdedness (how shared this address is) — high → "same address" is weak evidence.
		const freq = a.address?.raw ? addressFrequency.frequency(a.address.raw) : 0
		f.push(Math.min(1, freq * 1000))
		// #625 roll-up signature (2026-07-06 adjudication): every genuine over-merge in the adjudicated
		// packet was a MANAGEMENT-COMPANY roll-up — differently-branded operating entities at a shared
		// corporate/billing address where the AUTHORIZED OFFICIAL also agrees (the operator signs
		// everything). The official is NOT in the comparison set (discriminators are excluded from the
		// learned feature model), so the GBT could never see — let alone learn — that officialAgree in
		// the presence of orgDisagree is ANTI-identity evidence. These three appended features express
		// it directly from `attributes.authorizedOfficial`; appended at the END so models trained
		// without them (the cross-source GBT) keep scoring unchanged (trailing features are ignored).
		const offA = a.attributes?.["authorizedOfficial"]?.trim()
		const offB = b.attributes?.["authorizedOfficial"]?.trim()
		const officialAgree = offA && offB && nameSimilarity(offA, offB) >= 0.93 ? 1 : 0
		f.push(officialAgree)
		f.push(officialAgree * orgDisagree) // the roll-up core: same signer, different brand
		f.push(officialAgree * orgDisagree * spatialExact)

		// …at the same place

		// scale into a usable range
		return f
	}
}

/**
 * Wrap a trained {@link GBT} into the `(a, b) => number` link scorer for {@link ResolveConfig.scorer}. The returned
 * weight is the model's logit — same threshold-comparable units as the Fellegi-Sunter weight it replaces, so the
 * pipeline's clustering + threshold semantics are unchanged.
 */
export function createGbtScorer(
	config: LearnedFeatureConfig & { model: GBT }
): (a: SourceRecord, b: SourceRecord) => number {
	const featurize = createMatchFeaturizer(config)
	const { model } = config

	return (a, b) => gbtScore(model, featurize(a, b))
}
