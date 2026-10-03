/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The learned scorer, the production wiring for the gradient-boosted-tree model behind
 *   {@link ResolveConfig.scorer}.
 *
 *   {@link createMatchFeaturizer} is the one feature extractor for a candidate pair, used
 *   identically at train time (`registry/tools/train-gbt.ts`), eval time and inference time.
 *   {@link createGBTScorer} wraps a trained {@link GBT} and the featurizer into the `(a, b) => number`
 *   the resolve pipeline's `scorer` hook expects (a logit, threshold-comparable with the
 *   Fellegi-Sunter weight it replaces).
 *
 *   Both take the comparison set as input rather than importing {@link buildDefaultModel}, so this
 *   module has no dependency cycle with `resolve.ts`. Feed the comparisons from
 *   `buildDefaultModel({ collapseSpatial: true, addressFrequency })`, since that config fixes the
 *   feature layout.
 */

import {
	agreementPattern,
	type Comparison,
	type GBT,
	gbtScore,
	nameSimilarity,
	type TermFrequencyTable,
} from "@mailwoman/match"

import type { SourceRecord } from "#types"

/**
 * Similarity at which two official names count as the same organization.
 *
 * Set high because the feature is a near-exact agreement signal rather than a fuzzy one.
 */
const OFFICIAL_NAME_AGREEMENT = 0.93

/**
 * Inputs shared by the featurizer + the scorer factory.
 */
export interface LearnedFeatureConfig {
	/**
	 * The comparison set the features are built over.
	 *
	 * It must be `buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons`
	 * so the feature layout matches the trained model.
	 *
	 * `usePhone` and `discriminators` are not part of the learned feature model,
	 * since the GBT replaces the Fellegi-Sunter weight wholesale and owns its feature vector.
	 */
	comparisons: Comparison<SourceRecord>[]
	/**
	 * Address-frequency table for the crowdedness feature (a crowded shared address is weak identity).
	 */
	addressFrequency: TermFrequencyTable
}

/**
 * Build the per-pair feature extractor.
 *
 * The vector is: one-hot of each comparison's agreement level, then the two over-merge
 * interaction terms (spatial-exact × name-disagree, spatial-exact × org-disagree,
 * the "same place, different names" signature that drives co-located over-merges),
 * then address crowdedness scaled into [0, 1].
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

		const spatialExact = spatialI !== undefined && pat[spatialI] === 0 ? 1 : 0

		const nameDisagree =
			givenI !== undefined &&
			familyI !== undefined &&
			pat[givenI] === lastLevel(givenI) &&
			pat[familyI] === lastLevel(familyI)
				? 1
				: 0

		const orgDisagree = orgI !== undefined && pat[orgI] === lastLevel(orgI) ? 1 : 0
		f.push(spatialExact * nameDisagree)
		f.push(spatialExact * orgDisagree)
		const freq = a.address?.raw ? addressFrequency.frequency(a.address.raw) : 0
		f.push(Math.min(1, freq * 1000))
		// Roll-up signature: a shared corporate address can host differently-branded
		// operating entities whose authorized official also agrees.
		// The official is not in the comparison set, so these three features express that evidence directly.
		// They are appended at the end, so models trained without them keep scoring unchanged.
		const offA = a.attributes?.["authorizedOfficial"]?.trim()
		const offB = b.attributes?.["authorizedOfficial"]?.trim()
		const officialAgree = offA && offB && nameSimilarity(offA, offB) >= OFFICIAL_NAME_AGREEMENT ? 1 : 0
		f.push(officialAgree)
		f.push(officialAgree * orgDisagree)
		f.push(officialAgree * orgDisagree * spatialExact)

		return f
	}
}

/**
 * Wrap a trained {@link GBT} into the `(a, b) => number` link scorer for {@link ResolveConfig.scorer}.
 *
 * The returned weight is the model's logit.
 * Same threshold-comparable units as the Fellegi-Sunter weight it replaces,
 * so the pipeline's clustering + threshold semantics are unchanged.
 */
export function createGBTScorer(
	config: LearnedFeatureConfig & { model: GBT }
): (a: SourceRecord, b: SourceRecord) => number {
	const featurize = createMatchFeaturizer(config)
	const { model } = config

	return (a, b) => gbtScore(model, featurize(a, b))
}
