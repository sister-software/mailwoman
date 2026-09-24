/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Library interface for running the EDGAR ingest against the SEC and writing subsidiary rows. The CLI handles
 *   arguments, rendering, and exit codes; this module returns the data it needs.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"

import { parseCIKLookupData, type CompanyTickerEntry } from "#sdk/edgar/filings/index"
import { collectEdgarSubsidiaryRows, type EdgarIngestReport } from "#sdk/edgar/ingest"
import { createSECClient } from "#sdk/sec-client"

export type { EdgarIngestReport, EdgarSkipReason } from "#sdk/edgar/ingest"

export interface FilerEdgarIngestOptions {
	/**
	 * Company names to resolve.
	 * Blank lines are skipped.
	 */
	queries: string[]
	/**
	 * Output directory for subsidiary JSONL rows.
	 */
	outDir: string
	/**
	 * Optional CIK lookup file, with one `name:CIK:` entry per line.
	 */
	cikLookupPath?: string
	/**
	 * CIKs treated as corroborated regardless of SIC.
	 */
	pinnedCIKs?: string[]
	/**
	 * Called when each registrant finishes.
	 */
	onOutcome?: (outcome: { query: string; ok: boolean; subsidiaries: number; detail: string }) => void
}

export interface FilerEdgarIngestResult {
	report: EdgarIngestReport
	jsonlPath: string
	lookupEntries: number
}

/**
 * Run EDGAR ingestion and write subsidiary rows to `outDir`.
 * Parse the optional CIK lookup file once and reuse it.
 */
export async function filerEdgarIngest(options: FilerEdgarIngestOptions): Promise<FilerEdgarIngestResult> {
	const client = createSECClient()

	const tickers: CompanyTickerEntry[] = options.cikLookupPath
		? parseCIKLookupData(await readLocalTextFile(options.cikLookupPath))
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

	const { join } = await import("path-ts")

	await makeDirectories(options.outDir)

	const jsonlPath = join(options.outDir, "edgar-subsidiaries.jsonl")
	const lines = rows.map((row) => stringifyJSON(row))

	await writeLocalTextFile(lines, jsonlPath)

	return { report, jsonlPath, lookupEntries: tickers.length }
}
