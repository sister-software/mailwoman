/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus ingest-csv --input <path.csv> [--table <name>] [--output <path.db>]` — CSV →
 *   SQLite ingestion with sampled type inference. `--dry-run` prints the inferred CREATE TABLE
 *   without importing.
 */

import { ingestCSV } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	input: zod.string().describe("CSV file to ingest"),
	table: zod.string().optional().describe("SQLite table name (default: derived from the input filename)"),
	output: zod.string().optional().describe("SQLite database path (default: <input dir>/<name>.db)"),
	sample: zod.number().default(100).describe("Rows sampled for type inference"),
	separator: zod.string().default(",").describe("Field separator"),
	skip: zod.number().default(0).describe("Lines to skip before the header"),
	noHeader: zod.boolean().default(false).describe("CSV has no header row — columns become col_0, col_1, …"),
	dryRun: zod.boolean().default(false).describe("Infer the schema and print CREATE TABLE without importing"),
})

export { OptionsSchema as options }

const CorpusIngestCSV: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => ingestCSV(options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default CorpusIngestCSV
