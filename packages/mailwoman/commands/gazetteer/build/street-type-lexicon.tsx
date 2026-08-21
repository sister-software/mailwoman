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
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "street-type-lexicon",
	description: "Build the street-type evidence lexicon.",
	options: {
		output: { type: "string", description: "Output path (default <repo>/data/gazetteer/street-type-lexicon-v3.json)" },
	},
} as const satisfies CommandSpec

interface Options {
	output?: string
}

const GazetteerBuildStreetTypeLexicon: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildStreetTypeLexicon } = await import("#gazetteer/evidence-lexicons")
		const built = await buildStreetTypeLexicon({ output: options.output })

		return `${built.path} — ${built.entries} surfaces, max_ngram=${built.maxNgram}`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildStreetTypeLexicon
