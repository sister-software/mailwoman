/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate corpus-us-abbrev-region-samples` regenerates `corpus/us/abbrev-region-samples.ts`,
 *   the sample localities and postcodes for each US state whose code is also a country code, from the Who's On First
 *    admin and US postcode databases under the data root. The output is committed for provenance.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, reportToStderr, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "corpus-us-abbrev-region-samples",
	description: "Generate the US state-code contrast samples from Who's On First",
} as const satisfies CommandSpec

const DevGenerateCorpusUSAbbrevRegionSamples = () => {
	const state = useCommandTask(async () => {
		const { generateUSAbbrevRegionSamples } = await import("#tools/dev-tools/corpus/us-abbrev-region-samples")

		return generateUSAbbrevRegionSamples({}, reportToStderr)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath} ({state.result.states} states)
			</Text>
		)
	}

	return null
}

export default DevGenerateCorpusUSAbbrevRegionSamples
