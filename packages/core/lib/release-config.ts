/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The typed reader of `release.config.json`, the register that names the shipped model, tokenizer and soft-feed
 *   artifacts per locale. One home, because it is read at publish time (`packages/release-kit/lib/weights/copy-weights.ts`), by the overlay
 *   writers (`packages/release-kit/lib/weights/link-weights-overlay.ts`, the per-locale `link-dev-weights.ts` manifests through
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`) and by the HF fetch — and a reader that lived under
 *   `scripts/` was unreachable from the package, which is how the linker came to hardcode the lexicon filenames the
 *   config already names.
 */

import { resolvePath, type PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * One country's placetype-pair index inputs, as `softFeed.pairIndexByCountry[<cc>]` writes them. Entries are
 * heterogeneous — `gb` names a `source` CSV, `us` only a `boroughDB` — so every field is optional and unknown keys
 * pass.
 */
export interface PairIndexInputs {
	source?: string
	delta: number
	transitionBeta?: number
	parentDelta?: number
	boroughDB?: string
	// oxlint-disable-next-line sister-software/no-title-case-acronym -- mirrors release.config.json's literal `pairsJsonl` wire key; renaming the member would stop it typing the parsed JSON
	pairsJsonl?: string
	banDir?: string
	[key: string]: unknown
}

/**
 * The soft-feed block: the committed lexicons (repo-relative), the built locality-surface lexicon (data-root-relative),
 * and the per-country postcode extracts and pair-index inputs.
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

export interface ReleaseConfig {
	locales: string[]
	weights: { model: string; tokenizer: string; lineage?: string }
	softFeed?: SoftFeedRecipe
	assets?: { hfBucket?: string; [key: string]: unknown }
}

/**
 * Read `release.config.json` from the repository root (the checkout's, by default).
 */
export async function readReleaseConfig(repoRoot: PathBuilderLike = repoRootPathBuilder()): Promise<ReleaseConfig> {
	return readLocalJSONFile<ReleaseConfig>(repoRoot, "release.config.json")
}

/**
 * The lexicons that are COMMITTED to the repository, by the name they take in a weights package and the `softFeed` key
 * that names their repo-relative source. The locality-surface lexicon is not here: it is built, lives in the data root,
 * and is resolved by `softFeed.localitySurfaceLexicon` against that root instead.
 */
export const REPO_COMMITTED_SOFT_FEED_CHANNELS = [
	["anchor-lexicon-v1.json", "gazetteerLexicon"],
	["country-surface-lexicon-v1.json", "countryLexicon"],
	["street-type-lexicon-v3.json", "streetTypeLexicon"],
] as const satisfies ReadonlyArray<readonly [string, keyof SoftFeedRecipe]>

/**
 * Shipped name → absolute source path for every committed soft-feed lexicon the config names.
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
