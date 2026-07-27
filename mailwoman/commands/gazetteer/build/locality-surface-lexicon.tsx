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
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	countries: zod.string().optional().describe("Comma-separated countries (default US,FR)"),
	placetypes: zod
		.string()
		.optional()
		.describe("Comma-separated child placetypes (default locality,localadmin,neighbourhood)"),
	db: zod.string().optional().describe("WOF admin DB (default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)"),
	output: zod.string().optional().describe("Output path (default $MAILWOMAN_DATA_ROOT/gazetteer/…-v4.json)"),
})

export { OptionsSchema as options }

const GazetteerBuildLocalitySurfaceLexicon: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocalitySurfaceLexicon } = await import("../../../gazetteer-pipeline/evidence-lexicons.ts")
		const built = buildLocalitySurfaceLexicon({
			countries: options.countries?.split(",").map((s) => s.trim()),
			placetypes: options.placetypes?.split(",").map((s) => s.trim()),
			dbPath: options.db,
			output: options.output,
			onProgress: (line) => console.error(line),
		})

		return `${built.path} — ${built.entries} entries (${built.homographs} homograph-flagged; ${built.skippedDegenerate} degenerate + ${built.skippedProminence} sub-prominence skipped), max_ngram=${built.maxNgram}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildLocalitySurfaceLexicon
