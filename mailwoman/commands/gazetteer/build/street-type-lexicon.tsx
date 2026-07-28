/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build street-type-lexicon` — the Option-A bundle's street-type evidence
 *   artifact (codex fr/us/gb/de/ca street vocabulary; canonical words case-insensitive,
 *   abbreviations uppercase-gated). Small artifact, committed at `data/gazetteer/`.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	output: zod.string().optional().describe("Output path (default <repo>/data/gazetteer/street-type-lexicon-v3.json)"),
})

export { OptionsSchema as options }

const GazetteerBuildStreetTypeLexicon: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildStreetTypeLexicon } = await import("../../../gazetteer-pipeline/evidence-lexicons.ts")
		const built = await buildStreetTypeLexicon({ output: options.output })

		return `${built.path} — ${built.entries} surfaces, max_ngram=${built.maxNgram}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildStreetTypeLexicon
