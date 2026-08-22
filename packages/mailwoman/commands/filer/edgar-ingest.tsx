/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman filer edgar-ingest` — run the EDGAR chain against live SEC filings and write
 *   `EdgarSubsidiaryRow`s to JSONL. Reads company names from a file (one per line) and a CIK lookup index
 *   (`cik-lookup-data.txt`); requires `SEC_EDGAR_USER_AGENT` set in the environment. Paced at 9 req/s.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "edgar-ingest",
	description: "Ingest EDGAR subsidiary relationships to JSONL.",
	options: {
		names: { type: "string", required: true, description: "Path to a file with one company name per line" },
		lookup: { type: "string", description: "Path to cik-lookup-data.txt (fetched from EDGAR when omitted)" },
		"out-dir": {
			type: "string",
			default: "./edgar-ingest",
			description: "Directory to write edgar-subsidiaries.jsonl to",
		},
		pin: { type: "string", multiple: true, description: "CIK to pin as corroborated (repeatable)" },
	},
} as const satisfies CommandSpec

interface Options {
	names: string
	lookup?: string
	outDir: string
	pin?: string[]
}

const FilerEdgarIngest: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { filerEdgarIngest } = await import("@mailwoman/filer/tools")

		const { readFileSync } = await import("node:fs")

		// oxlint-disable mailwoman/prefer-spliterator -- command input is materialized for the batch lookup below
		const names = readFileSync(options.names, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)

		// oxlint-enable mailwoman/prefer-spliterator

		return filerEdgarIngest({
			queries: names,
			outDir: options.outDir,
			cikLookupPath: options.lookup,
			pinnedCIKs: options.pin,
			onOutcome: (outcome) => {
				const prefix = outcome.ok ? "✓" : "✗"

				console.error(`  ${prefix} ${outcome.query} — ${outcome.detail}`)
			},
		})
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { report, jsonlPath, lookupEntries } = state.result

		return (
			<Text color="green">
				edgar-ingest · {report.registrantsWithRows}/{report.outcomes.length} registrants · {report.rows} rows ·{" "}
				{lookupEntries.toLocaleString()} index entries · wrote {jsonlPath}
				{report.skipped.uncorroborated > 0 ? (
					<Text color="yellow">
						{"\n"} {report.skipped.uncorroborated} uncorroborated — pin with --pin to override
					</Text>
				) : null}
				{report.skipped["ambiguous-cik"] > 0 ? (
					<Text color="yellow">
						{"\n"} {report.skipped["ambiguous-cik"]} ambiguous — genuine CIK tie, both corroborated
					</Text>
				) : null}
			</Text>
		)
	}

	return null
}

export default FilerEdgarIngest
