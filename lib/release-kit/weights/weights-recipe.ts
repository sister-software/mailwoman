/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `release.config.json`'s `weights` + `softFeed` blocks, resolved to absolute paths — the one reader of
 *   the dev/release weights recipe.
 *
 *   Each key has its own base directory. The JSON does not record that choice. The model and tokenizer
 *   resolve against the data root. Three of the four lexicons resolve against the repo. They are
 *   generated and committed. `localitySurfaceLexicon` resolves against the data root because it is built.
 *   The postcode databases resolve under the data root's `wof/`. A reader that guessed one rule would
 *   silently resolve four of the seven artifact classes to nonexistent paths.
 */

import { readReleaseConfig, repoCommittedSoftFeedSources, type SoftFeedRecipe } from "@mailwoman/core/release-config"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * A file the recipe names that can be materialized by copying or linking it.
 *
 * `shippedName` is the filename the artifact must have in a weights directory rather than
 * its source basename: `resolveFromPackageDir` finds siblings by fixed name, so an artifact
 * placed under its source name resolves to no path and reports absence rather than failing.
 */
export interface LinkableArtifact {
	shippedName: string
	sourcePath: PathBuilderLike
}

/**
 * An artifact the recipe names that must be built rather than copied.
 *
 * This type stays separate from {@link LinkableArtifact}.
 * A consumer that treated it as linkable would place a database where the resolver expects a binary.
 *
 * The resolver would then report the database as missing instead of reporting its wrong type.
 */
export interface BuildableArtifact {
	shippedName: string
	/**
	 * The build's input, resolved, or `""` when the build takes several inputs
	 * and per-country tuning rather than one path.
	 *
	 * Empty means "this build is owed", never "the input is missing".
	 */
	inputPath: string
	/**
	 * The CLI verb that produces `shippedName` from `inputPath`, for a consumer
	 * that reports what it did not build.
	 */
	buildCommand: string
}

export interface WeightsRecipe {
	locales: string[]
	model: string
	tokenizer: string
	lineage: string | null
	softFeed: SoftFeedRecipe
	/**
	 * Files this recipe names for a locale.
	 *
	 * Absent entries are omitted, so a release that ships without a channel is a
	 * supported lean install rather than an error.
	 */
	linkableFor: (locale: string) => LinkableArtifact[]
	/**
	 * Artifacts this recipe names for a locale that a build step must produce, reported
	 * rather than silently skipped so a consumer can say which channels a directory will lack.
	 */
	buildableFor: (locale: string) => BuildableArtifact[]
}

/**
 * Read and resolve the recipe.
 *
 * `overrides` contains the publish-time environment escapes and their dev twins,
 * so a caller experimenting with a non-default model passes it here rather than each
 * consumer re-reading the environment and disagreeing about precedence.
 */
export async function readWeightsRecipe(
	repoRoot: PathBuilder,
	dataRoot: PathBuilder,
	overrides: { model?: string; tokenizer?: string } = {}
): Promise<WeightsRecipe> {
	const config = await readReleaseConfig(repoRoot)
	const softFeed = config.softFeed ?? {}

	const model = overrides.model ?? resolvePath(dataRoot, config.weights.model)
	const tokenizer = overrides.tokenizer ?? resolvePath(dataRoot, config.weights.tokenizer)

	// `copy-weights.ts` lets an absolute config entry pass through.
	// This match keeps the two readers from disagreeing about what a leading slash means.
	const underDataRoot = (rel: string, base: PathBuilder = dataRoot): string =>
		rel.startsWith("/") ? rel : resolvePath(base, rel)

	const linkableFor = (locale: string): LinkableArtifact[] => {
		const out: LinkableArtifact[] = [
			{ shippedName: "model.onnx", sourcePath: model },
			{ shippedName: "tokenizer.model", sourcePath: tokenizer },
		]

		// Repo-relative: generated and committed, so they travel with the checkout.
		for (const [shippedName, sourcePath] of repoCommittedSoftFeedSources(repoRoot, softFeed)) {
			out.push({ shippedName, sourcePath })
		}

		// Data-root-relative: built and never in git, the asymmetry with the committed lexicons above.
		if (softFeed.localitySurfaceLexicon) {
			out.push({
				shippedName: "locality-surface-lexicon-v7.json",
				sourcePath: underDataRoot(softFeed.localitySurfaceLexicon),
			})
		}

		// The FSTs are DEV-only: `release.config.json` does not name them and `copy-weights.ts`
		// does not ship them, so their absence is not a lean install.
		// It silently resolves the gazetteer and street-context priors off, a scoring change with no error.
		out.push(
			{
				shippedName: `fst-${locale}.bin`,
				sourcePath: wofDatabaseRoot(dataRoot)("fst-per-locale", `fst-${locale}.bin`),
			},
			{
				shippedName: "fst-street-morphology.bin",
				sourcePath: wofDatabaseRoot(dataRoot)("fst-street-morphology.bin"),
			}
		)

		return out
	}

	const buildableFor = (locale: string): BuildableArtifact[] => {
		const country = locale.split("-")[1]?.toLowerCase() ?? ""

		if (!country) return []

		const out: BuildableArtifact[] = []
		const postcodeDB = softFeed.postcodeDBByCountry?.[country]

		if (postcodeDB) {
			out.push({
				shippedName: `postcode-${country}.bin`,
				inputPath: underDataRoot(postcodeDB, wofDatabaseRoot(dataRoot)),
				buildCommand: "mailwoman gazetteer postcode-binary",
			})
		}

		// Presence rather than a path: the pair-index entries are heterogeneous —
		// `gb` names a `source`, `us` only a `boroughDB`, and each country has its own tuning —
		// and the build that reads them lives in `buildPairIndexOverlay`.
		// Report that a build is owed and leave it where it lives.
		if (softFeed.pairIndexByCountry?.[country]) {
			out.push({
				shippedName: `pair-index-${country}.bin`,
				inputPath: "",
				buildCommand: `${locale}'s scripts/link-dev-weights.ts (buildPairIndexOverlay)`,
			})
		}

		return out
	}

	return {
		locales: config.locales,
		model,
		tokenizer,
		lineage: config.weights.lineage || null,
		softFeed,
		linkableFor,
		buildableFor,
	}
}
