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

/**
 * A char-path base package's binaries (#2164), keyed by script family (`cjk`). Paths are data-root relative, like
 * `weights.model`. The vocabulary is committed in the package too; the recipe's copy keeps it in step with the graph.
 */
export interface CharWeightsRecipe {
	model: string
	charVocab: string
	lineage?: string
	/**
	 * The data-only overlays that inherit this family's graph through `mailwoman.baseWeights` (`ja-jp`, `zh-cn`): each
	 * ships its locale FST and nothing of the model, and is staged and fetched under the FAMILY's bucket directory.
	 */
	overlays?: string[]
}

export interface ReleaseConfig {
	locales: string[]
	weights: { model: string; tokenizer: string; lineage?: string }
	charWeights?: Record<string, CharWeightsRecipe>
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
 * Every locale package the config ships, Latin and character-path alike.
 *
 * `locales` and `charWeights[].overlays` are two halves of one list: an overlay under `charWeights` ships beside the
 * Latin ones and is invisible to a reader that consults only the first. A census that reads one half reports a country
 * with a shipping overlay as having none.
 *
 * Lives here rather than beside a consumer because a reader that lives outside this package is unreachable from one,
 * which is how a package comes to hardcode what the config names.
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
 * Country → the locale package that scopes it, DERIVED from {@link shippingLocales} rather than restated.
 *
 * The region subtag of a locale package IS the country it scopes — `en-au` scopes AU, `zh-cn` scopes CN — so a
 * hand-written table is a second copy of `release.config.json`'s two lists, and the copy is what goes stale when a
 * locale ships. `repo-health`'s `locale-tables` check exists because that copy existed.
 *
 * Existence is not training: a country here has a package that SCOPES it, which says nothing about whether the corpus
 * carries rows for it. A tag with no region subtag contributes nothing rather than a blank key.
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
