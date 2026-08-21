/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev jsonl-to-parquet --input <labeled.jsonl> --output <shard.parquet>` — convert a
 *   JSONL of LabeledRow objects to a Parquet shard matching the v0.5.0 corpus schema. The #519
 *   char-offset span triple is REQUIRED on every row; a row without it fails loudly with its line
 *   number.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "jsonl-to-parquet",
	description: "Convert labeled-row JSONL to a Parquet corpus shard.",
	options: {
		input: { type: "string", required: true, description: "The labeled-row JSONL to convert" },
		output: { type: "string", required: true, description: "The parquet shard to write" },
		"row-group-size": { type: "number", default: 50_000, description: "Parquet row-group size" },
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	output: string
	rowGroupSize: number
}

const report = (line: string): void => console.error(line)

const DevJSONLToParquet: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { jsonlToParquet } = await import("@mailwoman/corpus/tools")

		return jsonlToParquet({ input: options.input, output: options.output, rowGroupSize: options.rowGroupSize }, report)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ {state.result.read} rows read, {state.result.written} written → {state.result.outPath}
			</Text>
		)
	}

	return null
}

export default DevJSONLToParquet
