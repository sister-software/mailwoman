/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads `release.config.json`, which lists the shipped locales and their model, tokenizer and soft-feed artifacts.
 */

import { resolvePath, type PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * One country's placetype-pair index inputs from `softFeed.pairIndexByCountry[<cc>]`.
 *
 * Countries use different inputs.
 * For example, `gb` sets a `source` CSV and `us` sets only a `boroughDB`.
 *
 * Most fields are therefore optional, and unknown keys are allowed.
 */
export interface PairIndexInputs {
	source?: string
	delta: number
	transitionBeta?: number
	parentDelta?: number
	/**
	 * A WOF database filename, resolved under the data root's `db/wof/` directory.
	 */
	boroughDB?: string
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- The member must match the `pairsJsonl` key in release.config.json.
	pairsJsonl?: string
	banDir?: string
	[key: string]: unknown
}

/**
 * The `softFeed` block of the release config.
 *
 * The committed lexicon paths are repo-relative.
 * The built `localitySurfaceLexicon` path is relative to the data root.
 */
export interface SoftFeedRecipe {
	gazetteerLexicon?: string
	countryLexicon?: string
	streetTypeLexicon?: string
	localitySurfaceLexicon?: string
	pairIndexByCountry?: Record<string, PairIndexInputs>
	postcodeDBByCountry?: Record<string, string>
	[key: string]: unknown
}

/**
 * The artifacts of one character-path base package, such as `cjk`.
 *
 * Paths are relative to the data root, like `weights.model`.
 * The package also commits its vocabulary, and the `charVocab` copy here keeps
 * that vocabulary in step with the model graph.
 */
export interface CharWeightsRecipe {
	model: string
	charVocab: string
	lineage?: string
	/**
	 * Data-only locale overlays, such as `ja-jp` and `zh-cn`, that reuse this
	 * family's model through `mailwoman.baseWeights`.
	 *
	 * Each overlay ships only its locale FST and is staged under the family's bucket directory.
	 */
	overlays?: string[]
}

/**
 * The parsed `release.config.json`.
 */
export interface ReleaseConfig {
	locales: string[]
	weights: { model: string; tokenizer: string; lineage?: string }
	charWeights?: Record<string, CharWeightsRecipe>
	softFeed?: SoftFeedRecipe
	assets?: { hfBucket?: string; [key: string]: unknown }
}

/**
 * Reads `release.config.json` from a repository root, which defaults to this checkout.
 */
export async function readReleaseConfig(repoRoot: PathBuilderLike = repoRootPathBuilder()): Promise<ReleaseConfig> {
	return readLocalJSONFile<ReleaseConfig>(repoRoot, "release.config.json")
}

/**
 * Returns every shipped locale package, both from `locales` and from the `charWeights` overlays.
 *
 * A reader that consults only `locales` misses the character-path overlays.
 */
export function shippingLocales(config: Pick<ReleaseConfig, "locales" | "charWeights">): Set<string> {
	const locales = new Set(config.locales)

	for (const family of Object.values(config.charWeights ?? {})) {
		for (const overlay of family.overlays ?? []) {
			locales.add(overlay)
		}
	}

	return locales
}

/**
 * Maps each country code to the shipped locale package whose region subtag it matches.
 *
 * For example, `en-au` maps AU and `zh-cn` maps CN.
 * A locale without a region subtag is skipped.
 *
 * A country in the map has a package.
 * The training corpus may still lack rows for that country.
 */
export function weightsPackageByCountry(config: Pick<ReleaseConfig, "locales" | "charWeights">): Map<string, string> {
	const out = new Map<string, string>()

	for (const locale of shippingLocales(config)) {
		const region = locale.split("-")[1]

		if (region) {
			out.set(region.toUpperCase(), locale)
		}
	}

	return out
}

/**
 * The committed soft-feed lexicons, as pairs of shipped file name and the
 * `softFeed` key that holds the source path.
 *
 * The locality-surface lexicon is built into the data root, so it is resolved separately.
 */
export const REPO_COMMITTED_SOFT_FEED_CHANNELS = [
	["anchor-lexicon-v1.json", "gazetteerLexicon"],
	["country-surface-lexicon-v1.json", "countryLexicon"],
	["street-type-lexicon-v3.json", "streetTypeLexicon"],
] as const satisfies ReadonlyArray<readonly [string, keyof SoftFeedRecipe]>

/**
 * Maps each shipped lexicon name to its absolute source path, for every committed lexicon the config sets.
 */
export function repoCommittedSoftFeedSources(repoRoot: PathBuilderLike, softFeed: SoftFeedRecipe): Map<string, string> {
	const sources = new Map<string, string>()

	for (const [shippedName, key] of REPO_COMMITTED_SOFT_FEED_CHANNELS) {
		const rel = softFeed[key]

		if (typeof rel === "string") {
			sources.set(shippedName, resolvePath(repoRoot, rel))
		}
	}

	return sources
}
