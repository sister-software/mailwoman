/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus ingest-csv --input <path.csv> [--table <name>] [--out <path.db>]` — CSV →
 *   SQLite ingestion with sampled type inference. `--dry-run` prints the inferred CREATE TABLE
 *   without importing.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "ingest-csv",
	description: "Ingest CSV into SQLite with sampled type inference.",
	options: {
		input: { type: "string", required: true, description: "CSV file to ingest" },
		table: { type: "string", description: "SQLite table name (default: derived from the input filename)" },
		out: {
			type: "string",
			description: "SQLite database path (default: <input dir>/<name>.db)",
			deprecatedName: "output",
		},
		sample: { type: "number", default: 100, description: "Rows sampled for type inference" },
		separator: { type: "string", default: ",", description: "Field separator" },
		skip: { type: "number", default: 0, description: "Lines to skip before the header" },
		header: {
			type: "boolean",
			default: true,
			description:
				"The first row is the header; pass --no-header for a headerless CSV (columns become col_0, col_1, …)",
		},
		"dry-run": {
			type: "boolean",
			default: false,
			description: "Infer the schema and print CREATE TABLE without importing",
		},
	},
} as const satisfies CommandSpec

const CorpusIngestCSV: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { ingestCSV } = await import("@mailwoman/corpus/tools")
		// `out` is the CLI's spelling; `ingestCSV`'s own option is `output`, and spreading `rest` would hand it a key it
		// does not read, which is a silently missing destination rather than an error.
		const { header, out, ...rest } = options

		return ingestCSV({ ...rest, output: out, noHeader: !header })
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default CorpusIngestCSV
