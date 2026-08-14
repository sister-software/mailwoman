/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus ingest-csv --input <path.csv> [--table <name>] [--output <path.db>]` — CSV →
 *   SQLite ingestion with sampled type inference. `--dry-run` prints the inferred CREATE TABLE
 *   without importing.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "ingest-csv",
	description: "Ingest CSV into SQLite with sampled type inference.",
	options: {
		input: { type: "string", required: true, description: "CSV file to ingest" },
		table: { type: "string", description: "SQLite table name (default: derived from the input filename)" },
		output: { type: "string", description: "SQLite database path (default: <input dir>/<name>.db)" },
		sample: { type: "number", default: 100, description: "Rows sampled for type inference" },
		separator: { type: "string", default: ",", description: "Field separator" },
		skip: { type: "number", default: 0, description: "Lines to skip before the header" },
		"no-header": {
			type: "boolean",
			default: false,
			description: "CSV has no header row — columns become col_0, col_1, …",
		},
		"dry-run": {
			type: "boolean",
			default: false,
			description: "Infer the schema and print CREATE TABLE without importing",
		},
	},
} as const satisfies CommandSpec

interface Options {
	input: string
	table?: string
	output?: string
	sample: number
	separator: string
	skip: number
	noHeader: boolean
	dryRun: boolean
}

const CorpusIngestCSV: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { ingestCSV } = await import("@mailwoman/corpus/tools")

		return ingestCSV(options)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default CorpusIngestCSV
