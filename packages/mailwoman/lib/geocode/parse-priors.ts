/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The decode-time priors a production parse feeds the classifier: the gazetteer FST that ships
 *   beside the weights, the street-morphology matcher, and the venue-head lexicon of the input's
 *   country. The geocode session, the runtime pipeline, the gauntlet harness and the promotion
 *   battery load them through this module, so a switch graded on one path is the switch the other
 *   paths run.
 */

import { isCountryToken } from "@mailwoman/codex/country"
import { streetTypeWordTestFor } from "@mailwoman/codex/street-type"
import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { tryStat } from "@mailwoman/core/fs/readers/stat"
import {
	type AnchorRegionAncestor,
	type AnchorRegionLookupLike,
	type ClassifierOpts,
	type FSTMatcherLike,
	streetContextRequirementFor,
	type VenueHeadLexiconLike,
	type VenueHeadPriorOpts,
} from "@mailwoman/core/pipeline"
import type { PostcodePrefixIndexLike } from "@mailwoman/core/resolver"
import { isStreetAffix } from "@mailwoman/neural/fst-prior"
import { PostcodePrefixIndexResolver } from "@mailwoman/neural/postcode/prefix-index"
import { venueHeadLexicon } from "@mailwoman/poi-taxonomy/venue-heads"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"
import { probePostcodePrefix } from "@mailwoman/resolver/postcode/prefix"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * The data-root directory that holds the PFX1 postcode-prefix indexes, one file per country scope.
 */
export const POSTCODE_PREFIX_DIRECTORY = dataRootPath("postcode-prefix")

const POSTCODE_PREFIX_FILE_GLOB = "postcode-prefix-*.bin"

/**
 * The artifact paths a loaded classifier exposes for its priors.
 *
 * A classifier loaded from a weights package exposes both.
 * A classifier built from a bare ONNX path exposes neither, and the loader then returns no matcher.
 */
export interface ParsePriorArtifacts {
	/**
	 * The per-locale gazetteer FST, such as `fst-en-us.bin`.
	 */
	fstPath?: PathBuilderLike | null | undefined
	/**
	 * The sealed street-morphology FST.
	 *
	 * Absent, the loader builds the matcher from the bundled dictionaries.
	 */
	streetMorphologyPath?: string | null | undefined
}

/**
 * Options for {@link loadParsePriors}.
 */
export interface LoadParsePriorsOptions {
	/**
	 * Whether to load the gazetteer FST, and with it the street-morphology matcher.
	 *
	 * @defaultValue `true`
	 */
	gazetteerPrior?: boolean
	/**
	 * A gazetteer FST the caller already holds, used in place of the artifact at `fstPath`.
	 *
	 * The street-morphology matcher then loads beside it.
	 */
	fst?: FSTMatcherLike | null
	/**
	 * Whether {@link ParsePriors.venueHeadFor} returns a lexicon.
	 *
	 * @defaultValue `true`
	 */
	venueHeadPrior?: boolean
	/**
	 * The directory of PFX1 postcode-prefix indexes the anchor-region prior reads.
	 *
	 * @defaultValue {@linkcode POSTCODE_PREFIX_DIRECTORY}
	 */
	postcodePrefixDirectory?: PathBuilderLike
	/**
	 * A name for the classifier in warnings, such as its locale.
	 */
	label?: string
	/**
	 * Receives one message for each requested prior that could not be loaded.
	 *
	 * @defaultValue `console.warn`
	 */
	onWarn?: (message: string) => void
	/**
	 * Receives the artifacts the loader chose, such as the postcode-prefix index files.
	 *
	 * Absent, the choices are not reported.
	 */
	onReport?: (message: string) => void
}

/**
 * The loaded priors of one classifier.
 */
export interface ParsePriors {
	/**
	 * The gazetteer FST, or `null` when it was not requested or its artifact did not load.
	 */
	fst: FSTMatcherLike | null
	/**
	 * The street-morphology matcher, or `null` when the FST is absent or the matcher did not load.
	 *
	 * The street-context check needs both matchers, so the matcher is loaded only beside an FST.
	 */
	streetMorphology: FSTMatcherLike | null
	/**
	 * The admin ancestry of an anchored postcode, or `null` when the FST is absent
	 * or no postcode-prefix index loaded.
	 *
	 * The anchor-region prior confirms an FST region match, so the lookup is loaded only beside an FST.
	 */
	anchorRegions: AnchorRegionLookupLike | null
	/**
	 * The venue-head lexicon for a country, or `null` when the venue-head prior was not requested.
	 *
	 * A `null` country reads the language aggregates and no country table.
	 */
	venueHeadFor(country: string | null): VenueHeadLexiconLike | null
	/**
	 * The venue-head prior's overrides for a country, as {@link venueHeadOptsFor}
	 * builds them over the loaded street-morphology matcher.
	 */
	venueHeadOptsFor(country: string | null): VenueHeadPriorOpts
}

/**
 * Returns the venue-head prior's overrides for a country: the street-type test of
 * {@link streetTypeTestFor} and the codex's country-name test.
 */
export function venueHeadOptsFor(fst: FSTMatcherLike | null, country: string | null): VenueHeadPriorOpts {
	return { isStreetAffix: streetTypeTestFor(fst, country), isCountryName: isCountryToken }
}

/**
 * Returns the street-type test the venue-head prior reads for a country.
 *
 * The morphology FST accepts the street types of every locale but omits one-
 * and two-letter variants, so the codex's table for the country adds the abbreviations
 * it writes most, such as `St`, `Rd` and `NW` in the US.
 * A head followed by one of these is a street name, and one of these after a street name heads no venue.
 */
export function streetTypeTestFor(fst: FSTMatcherLike | null, country: string | null): (word: string) => boolean {
	const codex = streetTypeWordTestFor(country)

	return (word) => (fst !== null && isStreetAffix(fst, word)) || codex(word)
}

/**
 * Returns an anchor-region lookup over postcode-prefix indexes.
 *
 * A postcode is probed through {@linkcode probePostcodePrefix}, which derives the
 * prefix the index keys, in every index of the postcode's country.
 * The first index that holds the prefix answers.
 */
export function createAnchorRegionLookup(indexes: readonly PostcodePrefixIndexLike[]): AnchorRegionLookupLike {
	return {
		ancestorsFor(postcode: string, country: string): readonly AnchorRegionAncestor[] {
			for (const index of indexes) {
				const probe = probePostcodePrefix(postcode, index, country)

				if (probe) return probe.node.ancestors
			}

			return []
		},
	}
}

/**
 * Loads the newest PFX1 index of each country scope under `directory`.
 *
 * Index files carry a build date in their name, so several builds of one scope can sit side by side.
 * The newest by modification time wins, and the choice is reported through `report`.
 */
export async function loadPostcodePrefixIndexes(
	directory: PathBuilderLike,
	report: (message: string) => void
): Promise<PostcodePrefixIndexResolver[]> {
	const newest = new Map<string, { index: PostcodePrefixIndexResolver; mtimeMs: number; file: string }>()

	for await (const entry of Globerator.from(POSTCODE_PREFIX_FILE_GLOB, { cwd: directory.toString() })) {
		const file = PathBuilder.from(directory, entry)
		const stat = await tryStat(file)

		if (!stat) continue

		const index = new PostcodePrefixIndexResolver(new Uint8Array(await readLocalBuffer(file)))
		const scope = `${index.header.country}:${index.header.scope}`
		const current = newest.get(scope)

		if (!current || stat.mtimeMs > current.mtimeMs) {
			newest.set(scope, { index, mtimeMs: stat.mtimeMs, file: file.toString() })
		}
	}

	const chosen = [...newest.values()]

	if (chosen.length) {
		report(`postcode-prefix indexes: ${chosen.map((item) => item.file).join(", ")}`)
	}

	return chosen.map((item) => item.index)
}

/**
 * Loads the priors a production parse feeds the classifier.
 *
 * A requested prior whose artifact is absent or unreadable is reported through `onWarn`
 * and returned as `null`, because a parse without it is the base model's parse rather than the prior's.
 */
export async function loadParsePriors(
	artifacts: ParsePriorArtifacts,
	options: LoadParsePriorsOptions = {}
): Promise<ParsePriors> {
	const warn = options.onWarn ?? ((message: string) => console.warn(`[mailwoman] ${message}`))
	const label = options.label ?? "the classifier"

	let fst: FSTMatcherLike | null = options.fst ?? null
	let streetMorphology: FSTMatcherLike | null = null
	let anchorRegions: AnchorRegionLookupLike | null = null

	if (options.gazetteerPrior ?? true) {
		if (!fst && artifacts.fstPath) {
			try {
				fst = deserializeFST(await readLocalBuffer(artifacts.fstPath))
			} catch (error) {
				warn(`failed to load the gazetteer FST at ${artifacts.fstPath}: ${(error as Error).message}`)
			}
		}

		if (!fst) {
			warn(
				`the gazetteer prior was requested for ${label} but no FST artifact resolved` +
					`${artifacts.fstPath ? ` at ${artifacts.fstPath}` : " (the weights package ships none)"} — the gazetteer ` +
					"channel is off for this classifier. Results are the base model's, not the prior's."
			)
		}

		if (fst) {
			try {
				streetMorphology = (
					await loadStreetMorphologyFST({
						...(artifacts.streetMorphologyPath ? { artifactPath: artifacts.streetMorphologyPath } : {}),
						onWarn: warn,
					})
				).matcher
			} catch (error) {
				warn(`street-morphology FST unavailable: ${(error as Error).message} — check off`)
			}

			const directory = options.postcodePrefixDirectory ?? POSTCODE_PREFIX_DIRECTORY

			try {
				const indexes = await loadPostcodePrefixIndexes(directory, options.onReport ?? (() => {}))

				if (indexes.length) {
					anchorRegions = createAnchorRegionLookup(indexes)
				} else {
					warn(
						`no postcode-prefix index under ${directory} — the anchor-region prior is off for ${label}. ` +
							"A state name after an anchored postcode keeps the FST's own bias."
					)
				}
			} catch (error) {
				warn(
					`postcode-prefix indexes unavailable under ${directory}: ${(error as Error).message} — anchor-region prior off`
				)
			}
		}
	}

	const venueHeadPrior = options.venueHeadPrior ?? true
	const lexicons = new Map<string, VenueHeadLexiconLike>()
	const venueHeadOpts = new Map<string, VenueHeadPriorOpts>()

	return {
		fst,
		streetMorphology,
		anchorRegions,
		venueHeadOptsFor: (country) => {
			const key = (country ?? "").toUpperCase()
			let opts = venueHeadOpts.get(key)

			if (!opts) {
				opts = venueHeadOptsFor(streetMorphology, key || null)
				venueHeadOpts.set(key, opts)
			}

			return opts
		},
		venueHeadFor: (country) => {
			if (!venueHeadPrior) return null

			const key = (country ?? "").toUpperCase()
			let lexicon = lexicons.get(key)

			if (!lexicon) {
				lexicon = venueHeadLexicon(key)
				lexicons.set(key, lexicon)
			}

			return lexicon
		},
	}
}

/**
 * The switches that select which loaded priors a parse applies.
 */
export interface ParsePriorSelection {
	/**
	 * Whether the street-morphology matcher biases a street affix on a numbered segment.
	 *
	 * Without it the matcher serves the street-context check at zero emission weight.
	 */
	streetMorphologyPrior?: boolean
	/**
	 * The venue-head lexicon to apply, or `null` for none.
	 */
	venueHead?: VenueHeadLexiconLike | null
	/**
	 * Overrides for the venue-head prior, applied only with a lexicon.
	 */
	venueHeadOpts?: VenueHeadPriorOpts
}

/**
 * The classifier options that pass the loaded priors to one parse.
 */
export type ParsePriorOptions = Partial<
	Pick<
		ClassifierOpts,
		| "fst"
		| "fstStreetMorphology"
		| "fstStreetMorphologyOpts"
		| "fstStreetContextPositiveScale"
		| "anchorRegions"
		| "venueHead"
		| "venueHeadOpts"
	>
>

/**
 * Returns the classifier options that feed the loaded priors to a parse.
 *
 * The FST and the street-context options come from the core helper the runtime pipeline uses,
 * so every path passes the same weights for the same switch.
 * The anchor-region lookup passes only beside an FST, because it confirms an FST match.
 */
export function parsePriorOptions(
	priors: Pick<ParsePriors, "fst" | "streetMorphology"> & Partial<Pick<ParsePriors, "anchorRegions">>,
	selection: ParsePriorSelection = {}
): ParsePriorOptions {
	return {
		...(priors.fst ? { fst: priors.fst } : {}),
		...streetContextRequirementFor(
			{ fst: priors.fst, streetMorphology: priors.streetMorphology },
			{ streetMorphologyPrior: selection.streetMorphologyPrior ?? false }
		),
		...(priors.fst && priors.anchorRegions ? { anchorRegions: priors.anchorRegions } : {}),
		...(selection.venueHead ? { venueHead: selection.venueHead } : {}),
		...(selection.venueHead && selection.venueHeadOpts ? { venueHeadOpts: selection.venueHeadOpts } : {}),
	}
}
