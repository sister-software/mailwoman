/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reports WOF currency holes as a reviewable ledger; no output from this command changes a resolve.
 */

import { makeDirectories, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { Box, Text } from "ink"
import { PathBuilder, dirname } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import type { TriageRow, TriageSummary } from "#gazetteer-pipeline/wof/triage"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "triage",
	description: "Report WOF currency holes (deprecated / not-current records) as a reviewable ledger",
	options: {
		admin: { type: "string", description: "WOF admin DB. Default <data-root>/db/wof/admin-global-priority.db" },
		geonames: { type: "string", description: "GeoNames dump dir for attestation. Default <data-root>/geonames" },
		countries: { type: "string", description: "Comma-separated ISO codes. Default: every country in the artifact" },
		out: {
			type: "string",
			description: "JSONL ledger output. Default <data-root>/db/wof/triage/currency-<date>.jsonl",
		},
		uncoveredOnly: { type: "boolean", default: false, description: "Write only rows no live record covers" },
	},
} as const satisfies CommandSpec

const GazetteerTriage: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { isoDate } = await import("@mailwoman/core/utils")
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { CoverageVerdict, triageWOFCurrency } = await import("#gazetteer-pipeline/wof/triage")

		const adminDB = options.admin ?? wofDatabasePath("admin-global-priority.db")
		const geonamesDir = options.geonames ?? dataRootPath("geonames")

		const countries = extractDelimited(options.countries)

		const stamp = isoDate()
		const outPath = PathBuilder.from(options.out ?? wofDatabasePath("triage", `currency-${stamp}.jsonl`))

		const { rows, summary } = await triageWOFCurrency({
			adminDB,
			geonamesDir,
			...(countries.length ? { countries } : {}),
			onProgress: () => {},
		})

		const emitted = options.uncoveredOnly ? rows.filter((r) => r.coverage === CoverageVerdict.Uncovered) : rows

		await makeDirectories(dirname(outPath))
		await writeLocalJSONLFile(emitted, outPath)

		const queue = rows
			.filter((r) => r.coverage === CoverageVerdict.Uncovered && r.attestation.state === "attested")
			.toSorted((a, b) => (b.attestation.population ?? 0) - (a.attestation.population ?? 0))
			.slice(0, 10)

		return { outPath, emitted: emitted.length, total: rows.length, summary, queue }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} running="Triaging WOF currency…" />

	const { outPath, emitted, total, summary, queue } = state.result

	return (
		<Box flexDirection="column">
			<Text>
				✓ wrote {emitted.toLocaleString()} of {total.toLocaleString()} rows → {outPath}
			</Text>
			{summary
				.filter((s: TriageSummary) => s.uncovered > 0)
				.toSorted((a: TriageSummary, b: TriageSummary) => b.uncovered - a.uncovered)
				.slice(0, 12)
				.map((s: TriageSummary) => (
					<Text key={`${s.country}-${s.currencyClass}`}>
						{"  "}
						{s.country} {s.currencyClass}: {s.total.toLocaleString()} records — {s.uncovered.toLocaleString()}{" "}
						uncovered, {s.coveredCrossBand.toLocaleString()} cross-band
						{s.uncoveredAttested === undefined ? " (attestation unmeasured)" : `, ${s.uncoveredAttested} attested`}
					</Text>
				))}
			{queue.length > 0 && <Text>{"\n"}Review queue (uncovered + attested, most populous first):</Text>}
			{queue.map((r: TriageRow) => (
				<Text key={r.id}>
					{"  "}
					{r.name} ({r.country} {r.placetype}) — attested pop {(r.attestation.population ?? 0).toLocaleString()} at{" "}
					{r.latitude.toFixed(4)},{r.longitude.toFixed(4)} — wof:{r.id}
				</Text>
			))}
		</Box>
	)
}

export default GazetteerTriage
