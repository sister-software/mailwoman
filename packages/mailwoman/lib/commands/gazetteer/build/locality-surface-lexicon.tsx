/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build locality-surface-lexicon` — the Option-A bundle's locality-evidence
 *   artifact (three-law selectivity. v4 folds neighbourhood surfaces per the fragment-register
 *   doctrine). Large artifact → `$MAILWOMAN_DATA_ROOT/gazetteer/`, never git. ships as a
 *   weights-package sibling at the model promote that requires it.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
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
		db: { type: "string", description: "WOF admin DB (default $MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db)" },
		out: {
			type: "string",
			description: "Output path (default $MAILWOMAN_DATA_ROOT/gazetteer/…-v5.json)",
			deprecatedName: "output",
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildLocalitySurfaceLexicon: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocalitySurfaceLexicon } = await import("#gazetteer/evidence-lexicons")

		const built = await buildLocalitySurfaceLexicon({
			countries: options.countries === undefined ? undefined : extractDelimited(options.countries),
			placetypes: options.placetypes === undefined ? undefined : extractDelimited(options.placetypes),
			dbPath: options.db,
			output: options.out,
			onProgress: (line) => console.error(line),
		})

		return `${built.path} — ${built.entries} entries (${built.homographs} homograph-flagged; ${built.skippedDegenerate} degenerate + ${built.skippedRegionVocabulary} region-vocab + ${built.skippedSubPhrase} alt-subphrase + ${built.skippedProminence} sub-prominence skipped), max_ngram=${built.maxNgram}`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildLocalitySurfaceLexicon
