/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer triage` — the WOF currency-hole ledger (`gazetteer-pipeline/wof-triage.ts`).
 *
 *   REPORT ONLY. Nothing this command emits changes a resolve; the ledger exists so an upstream coverage hole is
 *   reviewable instead of invisible, and so a decision to supplement one is recorded rather than inferred. The
 *   motivating case is in the module docstring (`Rochester, Kent`, deprecated in a January 2019 batch with no
 *   successor, resolving 474 km away until the currency backfill).
 *
 *   Run it after every WOF pull. The summary alone answers "did upstream just delete a country's worth of places",
 *   which no build step asks today.
 */

import { mkdirSync, writeFileSync } from "@mailwoman/platform/fs"
import { dirname } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

import type { TriageRow, TriageSummary } from "../../gazetteer-pipeline/wof-triage.ts"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "triage",
	description: "Report WOF currency holes (deprecated / not-current records) as a reviewable ledger",
	options: {
		admin: { type: "string", description: "WOF admin DB. Default <data-root>/wof/admin-global-priority.db" },
		geonames: { type: "string", description: "GeoNames dump dir for attestation. Default <data-root>/geonames" },
		countries: { type: "string", description: "Comma-separated ISO codes. Default: every country in the artifact" },
		out: { type: "string", description: "JSONL ledger output. Default <data-root>/wof/triage/currency-<date>.jsonl" },
		uncoveredOnly: { type: "boolean", default: false, description: "Write only rows no live record covers" },
	},
} as const satisfies CommandSpec

interface Options {
	admin?: string
	geonames?: string
	countries?: string
	out?: string
	uncoveredOnly: boolean
}

const GazetteerTriage: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/utils")
		const { CoverageVerdict, triageWOFCurrency } = await import("../../gazetteer-pipeline/wof-triage.ts")

		const adminDB = options.admin ?? String(dataRootPath("wof", "admin-global-priority.db"))
		const geonamesDir = options.geonames ?? String(dataRootPath("geonames"))

		const countries = options.countries
			?.split(",")
			.map((cc) => cc.trim())
			.filter((cc) => cc.length > 0)

		const stamp = new Date().toISOString().slice(0, 10)
		const outPath = options.out ?? String(dataRootPath("wof", "triage", `currency-${stamp}.jsonl`))

		const { rows, summary } = await triageWOFCurrency({
			adminDB,
			geonamesDir,
			...(countries?.length ? { countries } : {}),
			onProgress: () => {},
		})

		const emitted = options.uncoveredOnly ? rows.filter((r) => r.coverage === CoverageVerdict.Uncovered) : rows

		mkdirSync(dirname(outPath), { recursive: true })
		writeFileSync(outPath, emitted.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")

		// The review queue's head: uncovered AND independently attested, most populous first — the rows most likely to
		// be an upstream mistake rather than a real cessation.
		const queue = rows
			.filter((r) => r.coverage === CoverageVerdict.Uncovered && r.attestation.state === "attested")
			.toSorted((a, b) => (b.attestation.population ?? 0) - (a.attestation.population ?? 0))
			.slice(0, 10)

		return { outPath, emitted: emitted.length, total: rows.length, summary, queue }
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status !== "done") return <Text>Triaging WOF currency…</Text>

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
