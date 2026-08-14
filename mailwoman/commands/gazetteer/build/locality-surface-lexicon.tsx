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

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

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
		const { buildLocalitySurfaceLexicon } = await import("../../../gazetteer-pipeline/evidence-lexicons.ts")

		const built = buildLocalitySurfaceLexicon({
			countries: options.countries?.split(",").map((s) => s.trim()),
			placetypes: options.placetypes?.split(",").map((s) => s.trim()),
			dbPath: options.db,
			output: options.output,
			onProgress: (line) => console.error(line),
		})

		return `${built.path} — ${built.entries} entries (${built.homographs} homograph-flagged; ${built.skippedDegenerate} degenerate + ${built.skippedRegionVocabulary} region-vocab + ${built.skippedSubPhrase} alt-subphrase + ${built.skippedProminence} sub-prominence skipped), max_ngram=${built.maxNgram}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildLocalitySurfaceLexicon
