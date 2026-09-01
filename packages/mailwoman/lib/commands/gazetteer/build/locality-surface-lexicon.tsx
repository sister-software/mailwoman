/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build locality-surface-lexicon` — the Option-A bundle's locality-evidence
 *   artifact (three-law selectivity; v4 folds neighbourhood surfaces per the fragment-register
 *   doctrine). Large artifact → `$MAILWOMAN_DATA_ROOT/gazetteer/`, never git; ships as a
 *   weights-package sibling at the model promote that requires it.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, splitList, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "locality-surface-lexicon",
	description: "Build the locality-surface evidence lexicon.",
	options: {
		countries: { type: "string", description: "Comma-separated countries (default US,FR)" },
		placetypes: {
			type: "string",
			description: "Comma-separated child placetypes (default locality,localadmin,neighbourhood)",
		},
		db: { type: "string", description: "WOF admin DB (default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)" },
		output: { type: "string", description: "Output path (default $MAILWOMAN_DATA_ROOT/gazetteer/…-v5.json)" },
	},
} as const satisfies CommandSpec

interface Options {
	countries?: string
	placetypes?: string
	db?: string
	output?: string
}

const GazetteerBuildLocalitySurfaceLexicon: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocalitySurfaceLexicon } = await import("#gazetteer/evidence-lexicons")

		const built = await buildLocalitySurfaceLexicon({
			countries: options.countries === undefined ? undefined : splitList(options.countries),
			placetypes: options.placetypes === undefined ? undefined : splitList(options.placetypes),
			dbPath: options.db,
			output: options.output,
			onProgress: (line) => console.error(line),
		})

		return `${built.path} — ${built.entries} entries (${built.homographs} homograph-flagged; ${built.skippedDegenerate} degenerate + ${built.skippedRegionVocabulary} region-vocab + ${built.skippedSubPhrase} alt-subphrase + ${built.skippedProminence} sub-prominence skipped), max_ngram=${built.maxNgram}`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildLocalitySurfaceLexicon
