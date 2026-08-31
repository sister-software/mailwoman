/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gnaf assemble --standard-dir <G-NAF/.../Standard> --out <assembled-au.jsonl>`
 *
 *   Assemble a sampled, component-labeled Australian address set from the G-NAF (Geocoded National
 *   Address File) relational PSV distribution — joining ADDRESS_DETAIL → STREET_LOCALITY → LOCALITY
 *   and reservoir-sampling across states. Streams via the house `PSVSpliterator`; memory stays
 *   bounded (the two lookup tables as Maps, the 16.9M address rows sampled in one pass).
 *
 *   The output JSONL is the input to the `gnaf` corpus adapter (`mailwoman corpus build`), which
 *   renders each tuple in multiple word orders to teach the model AU's postcode-first layout
 *   (#208). `--holdout` excludes the benchmark addresses by (street, locality, postcode) so the
 *   training shard never overlaps the eval. Open G-NAF licence — attribute "Geoscape Australia".
 */

import { Box, Text } from "ink"
import { useState } from "react"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "assemble",
	description: "Assemble a sampled component-labeled G-NAF address set.",
	options: {
		"standard-dir": { type: "string", required: true, description: "G-NAF Standard directory" },
		n: {
			type: "number",
			default: 150_000,
			validate: (value) => Number.isInteger(value) && value > 0,
			validationMessage: "--n must be a positive integer.",
			description: "Sample size",
		},
		out: { type: "string", required: true, description: "Output JSONL path" },
		holdout: { type: "string", description: "Eval JSONL excluded from the training shard" },
	},
} as const satisfies CommandSpec

interface Options {
	standardDir: string
	n: number
	out: string
	holdout?: string
}

const GNAFAssemble: ParsedCommandComponent<Options> = ({ options }) => {
	const [progress, setProgress] = useState<string>()

	const state = useCommandTask(async () => {
		const { assembleGNAF } = await import("@mailwoman/corpus")

		return assembleGNAF({
			standardDir: options.standardDir,
			sampleSize: options.n,
			out: options.out,
			holdoutPath: options.holdout,
			onProgress: setProgress,
		})
	})

	if (state.status === "error") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const done = state.result

		return (
			<Box flexDirection="column">
				<Text>
					<Text color="green">✓</Text> {done.written.toLocaleString()} tuples sampled (of {done.seen.toLocaleString()}{" "}
					valid
					{done.heldOut ? `, ${done.heldOut.toLocaleString()} held out` : ""})
				</Text>
				<Text dimColor>
					by state:{" "}
					{Object.entries(done.byState)
						.map(([s, n]) => `${s}=${n}`)
						.join(" ")}
				</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column">
			<Text>assembling G-NAF Australian addresses…</Text>
			{progress ? <Text dimColor>{progress}</Text> : null}
		</Box>
	)
}

export default GNAFAssemble
