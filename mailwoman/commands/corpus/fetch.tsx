/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus fetch <source>` — reproducible bulk-download of the open-data sources the
 *   corpus build consumes (disk-loss recovery, weekly refresh, fresh-environment bootstrap). Each
 *   source writes its raw files plus a sibling `MANIFEST.json` (origin URL, timestamp, byte count,
 *   sha256). See `@mailwoman/corpus/tools` `fetch/index.ts` for the source registry + license tiers.
 */

import type { FetchSourceID, FetchSummary } from "@mailwoman/corpus/tools"
import {
	fetchBan,
	fetchHRSA,
	fetchIMLSPLS,
	fetchNAD,
	fetchNPPES,
	fetchOpenAddresses,
	fetchStateHISchools,
	fetchStateSources,
	fetchTigerFull,
} from "@mailwoman/corpus/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const args = zod.tuple([
	zod
		.enum([
			"ban",
			"nad",
			"hrsa",
			"imls-pls",
			"nppes",
			"openaddresses",
			"state-sources",
			"state-hi-schools",
			"tiger-full",
		])
		.describe(
			argument({
				name: "source",
				description: "Fetch source id (ban, nad, hrsa, imls-pls, nppes, openaddresses, state-sources, …)",
			})
		),
])

const OptionsSchema = zod.object({
	outRoot: zod
		.string()
		.default("data/corpus/sources")
		.describe("Destination root — each source writes its own subdirectory"),
	// nad
	mode: zod.enum(["featureserver", "bulk"]).optional().describe("nad: fetch strategy (default featureserver)"),
	nadUrl: zod.string().optional().describe("nad: pre-signed S3 URL for bulk mode"),
	chunkSize: zod.number().optional().describe("nad: records per output file (default 100000)"),
	pageSize: zod.number().optional().describe("nad: records per HTTP request (default 5000)"),
	concurrency: zod.number().optional().describe("nad: parallel page fetches within a chunk (default 4)"),
	startOid: zod.number().optional().describe("nad: start OBJECTID (default 1)"),
	endOid: zod.number().optional().describe("nad: stop before this OID (default: total count)"),
	// openaddresses
	country: zod.string().optional().describe("openaddresses: OA country collection code (default ca)"),
	// tiger-full
	skipStateFips: zod
		.string()
		.optional()
		.describe('tiger-full: space-separated 2-digit state FIPS to skip (default "50")'),
	rateSleep: zod.number().optional().describe("tiger-full: seconds between downloads (default 0.2)"),
	maxParallel: zod.number().optional().describe("tiger-full: concurrent downloads per state (default 4)"),
	dryRun: zod.boolean().default(false).describe("tiger-full: print planned downloads without fetching"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>

const report = (line: string): void => console.error(line)

function runSource(source: FetchSourceID, options: Options): Promise<FetchSummary> {
	const base = { outRoot: options.outRoot }

	switch (source) {
		case "ban":
			return fetchBan(base, report)
		case "nad":
			return fetchNAD(
				{
					...base,
					mode: options.mode,
					nadURL: options.nadUrl,
					chunkSize: options.chunkSize,
					pageSize: options.pageSize,
					concurrency: options.concurrency,
					startOID: options.startOid,
					endOID: options.endOid,
				},
				report
			)
		case "hrsa":
			return fetchHRSA(base, report)
		case "imls-pls":
			return fetchIMLSPLS(base, report)
		case "nppes":
			return fetchNPPES(base, report)
		case "openaddresses":
			return fetchOpenAddresses({ ...base, country: options.country }, report)
		case "state-sources":
			return fetchStateSources(base, report)
		case "state-hi-schools":
			return fetchStateHISchools(base, report)
		case "tiger-full":
			return fetchTigerFull(
				{
					...base,
					skipStateFips: options.skipStateFips,
					rateSleep: options.rateSleep,
					maxParallel: options.maxParallel,
					dryRun: options.dryRun,
				},
				report
			)
	}
}

const CorpusFetch: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(
		() => runSource(args[0], options),
		(summary) => (summary.failed > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { fetched, skipped, failed, failedCodes } = state.result

		return (
			<Text color={failed > 0 ? "red" : "green"}>
				{args[0]}: fetched {fetched}, skipped {skipped}, failed {failed}
				{failedCodes.length > 0 ? ` (${failedCodes.join(" ")})` : ""}
			</Text>
		)
	}

	return null
}

export default CorpusFetch
