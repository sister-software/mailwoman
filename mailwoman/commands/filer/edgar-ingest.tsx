/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman filer edgar-ingest` — run the EDGAR chain against live SEC filings and write
 *   `EdgarSubsidiaryRow`s to JSONL. Reads company names from a file (one per line) and a CIK lookup index
 *   (`cik-lookup-data.txt`); requires `SEC_EDGAR_USER_AGENT` set in the environment. Paced at 9 req/s.
 */

import { filerEdgarIngest } from "@mailwoman/filer/tools"
import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	names: zod.string().describe("Path to a file with one company name per line"),
	lookup: zod
		.string()
		.optional()
		.describe("Path to cik-lookup-data.txt (fetched from EDGAR over the network when omitted)"),
	outDir: zod.string().default("./edgar-ingest").describe("Directory to write edgar-subsidiaries.jsonl to"),
	pin: zod
		.string()
		.array()
		.optional()
		.describe("CIK to pin as corroborated (repeatable: --pin 0001514416 --pin 0001327688)"),
})

export { OptionsSchema as options }

const FilerEdgarIngest: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { readFileSync } = await import("node:fs")

		// oxlint-disable mailwoman/prefer-spliterator
		const names = readFileSync(options.names, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)

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
