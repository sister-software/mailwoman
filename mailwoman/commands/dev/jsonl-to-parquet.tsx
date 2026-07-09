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

import { jsonlToParquet } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	input: zod.string().describe("The labeled-row JSONL to convert"),
	output: zod.string().describe("The parquet shard to write"),
	rowGroupSize: zod.number().default(50000).describe("Parquet row-group size"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const DevJsonlToParquet: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		jsonlToParquet({ input: options.input, output: options.output, rowGroupSize: options.rowGroupSize }, report)
	)

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

export default DevJsonlToParquet
