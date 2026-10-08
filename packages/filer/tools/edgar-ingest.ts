/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the EDGAR ingest against the SEC and writes subsidiary rows.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"

import { parseCIKLookupData, type CompanyTickerEntry } from "#sdk/edgar/filings"
import { collectEdgarSubsidiaryRows, type EdgarIngestReport } from "#sdk/edgar/ingest"
import { createSECClient } from "#sdk/sec-client"

/**
 * Options for {@link filerEdgarIngest}.
 */
export interface FilerEdgarIngestOptions {
	/**
	 * Company names to resolve.
	 */
	queries: string[]
	/**
	 * Output directory for subsidiary JSONL rows.
	 */
	outDir: string
	/**
	 * CIK lookup file with one `name:CIK:` entry per line.
	 */
	cikLookupPath?: string
	/**
	 * CIKs treated as corroborated regardless of SIC.
	 */
	pinnedCIKs?: string[]
	/**
	 * Called when each registrant finishes.
	 */
	onResult?: (result: { query: string; ok: boolean; subsidiaries: number; detail: string }) => void
}

/**
 * Result of {@link filerEdgarIngest}.
 */
export interface FilerEdgarIngestResult {
	report: EdgarIngestReport
	jsonlPath: string
	lookupEntries: number
}

/**
 * Runs the EDGAR ingest and writes `edgar-subsidiaries.jsonl` to `outDir`.
 */
export async function filerEdgarIngest(options: FilerEdgarIngestOptions): Promise<FilerEdgarIngestResult> {
	const client = createSECClient()

	const tickers: CompanyTickerEntry[] = options.cikLookupPath
		? parseCIKLookupData(await readLocalTextFile(options.cikLookupPath))
		: []

	const pinnedSet = options.pinnedCIKs?.length ? new Set(options.pinnedCIKs) : undefined

	const { rows, report } = await collectEdgarSubsidiaryRows(client, options.queries, tickers, {
		pinnedCIKs: pinnedSet,
		onResult: options.onResult
			? (result) =>
					options.onResult?.({
						query: result.query,
						ok: !result.skipReason,
						subsidiaries: result.subsidiaries,
						detail:
							result.skipReason ??
							`${result.subsidiaries} subsidiaries, ${result.unparseable} unparseable, SIC ${result.sic ?? "?"}`,
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
