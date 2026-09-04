/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `release.config.json`'s `weights` + `softFeed` blocks, resolved to absolute paths — the ONE reader of
 *   the dev/release weights recipe.
 *
 *   This file exists because the recipe had three homes. `release.config.json` names the artifacts and
 *   carries the reasoning in `lineage`; `scripts/copy-weights.ts` reads it for the release; and ten
 *   each `neural-weights-<locale>` overlay's `scripts/link-dev-weights.ts` hardcoded a byte-identical copy of the
 *   same two paths for dev. The en-us copy's own docstring records what that cost:
 *
 *   > Bump this path, model-card.json `files_md5`, and release.config.json `weights.model` in LOCKSTEP on
 *   > each ship — the 9.0.0 release moved only release.config, which left this default and the card's md5
 *   > record on the prior base for a full release cycle.
 *
 *   Three legs, one of them pure duplication. This is the leg that goes.
 *
 *   THE BASE DIRECTORY IS PER KEY, and that is the trap this module exists to hold in one place. The model
 *   and tokenizer resolve against the DATA ROOT; three of the four lexicons resolve against the REPO
 *   (they are generated, committed files); `localitySurfaceLexicon` resolves against the DATA ROOT because
 *   it is built, not committed; and the postcode databases resolve against the data root's `wof/`. Nothing
 *   in the JSON marks which is which, so a reader that guessed one rule would silently resolve four of
 *   seven artifact classes to paths that do not exist — and every one of them degrades to `undefined`
 *   rather than failing.
 */

import { readReleaseConfig, repoCommittedSoftFeedSources, type SoftFeedRecipe } from "@mailwoman/core/release-config"
import { resolvePath, type PathBuilder, type PathBuilderLike } from "path-ts"

export {
	type PairIndexInputs,
	type ReleaseConfig,
	readReleaseConfig,
	repoCommittedSoftFeedSources,
	type SoftFeedRecipe,
} from "@mailwoman/core/release-config"

/**
 * A file the recipe names that can be materialized by copying or linking it.
 *
 * `shippedName` is the filename the artifact must carry in a weights directory — NOT its source basename. They differ,
 * and the difference is the contract: `resolveFromPackageDir` finds siblings by fixed name, so an artifact placed under
 * its source name resolves to nothing and reports absence rather than failing.
 */
export interface LinkableArtifact {
	shippedName: string
	sourcePath: PathBuilderLike
}

/**
 * An artifact the recipe names that must be BUILT, not copied — the source entry is a build INPUT.
 *
 * Kept in a separate type on purpose. `softFeed.postcodeDBByCountry[cc]` names a WOF postcode EXTRACT
 * (`postalcode-gb.db`) from which `mailwoman gazetteer postcode-binary` produces `postcode-gb.bin`;
 * `pairIndexByCountry[cc]` names a tuples CSV behind `pair-index-<cc>.bin`. A consumer that treated either as linkable
 * would place a database where the resolver expects a binary — and since every sibling degrades `existsSync →
 * undefined`, the resolver would then report the artifact ABSENT rather than wrong, which is the harder failure to
 * see.
 */
export interface BuildableArtifact {
	shippedName: string
	/**
	 * The build's input, resolved — or `""` when the build takes several inputs and per-country tuning rather than one
	 * path. Empty means "this build is owed", never "the input is missing".
	 */
	inputPath: string
	/**
	 * The CLI verb that produces `shippedName` from `inputPath`, for a consumer that reports what it did not build.
	 */
	buildCommand: string
}

export interface WeightsRecipe {
	locales: string[]
	model: string
	tokenizer: string
	lineage?: string
	softFeed: SoftFeedRecipe
	/**
	 * Files this recipe names for a locale. Absent entries are simply omitted — a release that ships without a channel is
	 * a supported lean install, not an error.
	 */
	linkableFor: (locale: string) => LinkableArtifact[]
	/**
	 * Artifacts this recipe names for a locale that a build step must produce. Reported rather than silently skipped, so
	 * a consumer can say which channels a directory will lack.
	 */
	buildableFor: (locale: string) => BuildableArtifact[]
}

/**
 * Read and resolve the recipe.
 *
 * `overrides` carries the two publish-time environment escapes (`MAILWOMAN_PUBLISH_MODEL` /
 * `MAILWOMAN_PUBLISH_TOKENIZER`) and their dev twins, so a caller experimenting with a non-default model passes it here
 * rather than each consumer re-reading the environment and disagreeing about precedence.
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

	// `copy-weights.ts` lets an absolute config entry pass through; matching that here keeps the two readers
	// from disagreeing about what a leading slash means.
	const underDataRoot = (rel: string, ...segments: string[]): string =>
		rel.startsWith("/") ? rel : resolvePath(dataRoot, ...segments, rel)

	const linkableFor = (locale: string): LinkableArtifact[] => {
		const out: LinkableArtifact[] = [
			{ shippedName: "model.onnx", sourcePath: model },
			{ shippedName: "tokenizer.model", sourcePath: tokenizer },
		]

		// Repo-relative: generated and COMMITTED, so they travel with the checkout.
		for (const [shippedName, sourcePath] of repoCommittedSoftFeedSources(repoRoot, softFeed)) {
			out.push({ shippedName, sourcePath })
		}

		// Data-root-relative: BUILT, ~7 MB, never in git. The asymmetry with the three above is the reason this
		// module exists rather than a `resolve(base, rel)` at each call site.
		if (softFeed.localitySurfaceLexicon) {
			out.push({
				shippedName: "locality-surface-lexicon-v7.json",
				sourcePath: underDataRoot(softFeed.localitySurfaceLexicon),
			})
		}

		// The FSTs are DEV-ONLY: `release.config.json` does not name them and `copy-weights.ts` does not ship
		// them, so they exist in a weights directory only because a dev linker put them there. Their absence is
		// therefore not a lean install — it silently resolves the gazetteer and street-context priors OFF, which
		// is a scoring change with no error. Named here so one reader knows the whole dev set.
		out.push(
			{
				shippedName: `fst-${locale}.bin`,
				sourcePath: dataRoot("wof", "fst-per-locale", `fst-${locale}.bin`),
			},
			{
				shippedName: "fst-street-morphology.bin",
				sourcePath: dataRoot("wof", "fst-street-morphology.bin"),
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
				inputPath: underDataRoot(postcodeDB, "wof"),
				buildCommand: "mailwoman gazetteer postcode-binary",
			})
		}

		// PRESENCE, not a path. The pair-index entries are heterogeneous — `gb` names a `source`, `us` names only a
		// `boroughDB`, and every country carries its own `delta` / `transitionBeta` / `parentDelta` tuning — and the
		// build that reads them is `buildPairIndexOverlay` in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`,
		// which each overlay's link script already calls with its own measured parameters. Modelling one input path
		// here was a guess: an earlier draft read a `db` key that no entry has, so this returned nothing for all eight
		// countries and the artifact silently never appeared as buildable. Report that a build is OWED and leave the
		// build where it lives.
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
		...(config.weights.lineage ? { lineage: config.weights.lineage } : {}),
		softFeed,
		linkableFor,
		buildableFor,
	}
}
