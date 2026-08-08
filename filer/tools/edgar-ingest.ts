/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman filer edgar-ingest`'s library half — the EDGAR chain against a live SEC client, with the
 *   full registrant index. No argv, no `process.exit`: the command owns argument parsing, rendering, and
 *   exit codes. Every field on the result is a number the command can render without importing another
 *   module.
 */

import { readFileSync } from "node:fs"

import { parseCIKLookupData, type CompanyTickerEntry } from "../sdk/edgar-filings.ts"
import { collectEdgarSubsidiaryRows, type EdgarIngestReport } from "../sdk/edgar-ingest.ts"
import { createSECClient } from "../sdk/sec-client.ts"

export type { EdgarIngestReport, EdgarSkipReason } from "../sdk/edgar-ingest.ts"

export interface FilerEdgarIngestOptions {
	/**
	 * Company names to resolve — one per line in a file, or passed as an array. Every name is tried; a blank line is
	 * skipped rather than producing an outcome.
	 */
	queries: string[]
	/**
	 * Output directory for the subsidiary rows as JSONL.
	 */
	outDir: string
	/**
	 * Optional CIK lookup-data file path (`cik-lookup-data.txt`, one `NAME:CIK:` per line).
	 */
	cikLookupPath?: string
	/**
	 * CIKs pinned as corroborated regardless of SIC.
	 */
	pinnedCIKs?: string[]
	/**
	 * Called once per registrant as it completes.
	 */
	onOutcome?: (outcome: { query: string; ok: boolean; subsidiaries: number; detail: string }) => void
}

export interface FilerEdgarIngestResult {
	report: EdgarIngestReport
	jsonlPath: string
	lookupEntries: number
}

/**
 * Run the EDGAR ingest chain against a live SEC client and write the subsidiary rows to `outDir` as JSONL.
 *
 * The ticker index is read from `cikLookupPath` when given; it is parsed to `CompanyTickerEntry[]` once and reused
 * across every query.
 */
export async function filerEdgarIngest(options: FilerEdgarIngestOptions): Promise<FilerEdgarIngestResult> {
	const client = createSECClient()

	const tickers: CompanyTickerEntry[] = options.cikLookupPath
		? parseCIKLookupData(readFileSync(options.cikLookupPath, "utf8"))
		: []

	const pinnedSet = options.pinnedCIKs?.length ? new Set(options.pinnedCIKs) : undefined

	const { rows, report } = await collectEdgarSubsidiaryRows(client, options.queries, tickers, {
		pinnedCIKs: pinnedSet,
		onOutcome: options.onOutcome
			? (outcome) =>
					options.onOutcome?.({
						query: outcome.query,
						ok: !outcome.skipReason,
						subsidiaries: outcome.subsidiaries,
						detail:
							outcome.skipReason ??
							`${outcome.subsidiaries} subsidiaries, ${outcome.unparseable} unparseable, SIC ${outcome.sic ?? "?"}`,
					})
			: undefined,
	})

	const { writeFileSync, mkdirSync } = await import("node:fs")
	const { join } = await import("node:path")

	mkdirSync(options.outDir, { recursive: true })

	const jsonlPath = join(options.outDir, "edgar-subsidiaries.jsonl")
	const lines = rows.map((row) => JSON.stringify(row))

	writeFileSync(jsonlPath, lines.join("\n") + "\n")

	return { report, jsonlPath, lookupEntries: tickers.length }
}
