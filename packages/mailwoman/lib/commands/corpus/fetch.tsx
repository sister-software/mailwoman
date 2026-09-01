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
import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	splitList,
	useCommandTask,
} from "#cli-kit"

const sources = [
	"ban",
	"nad",
	"geonames-dump",
	"geonames-postal",
	"hrsa",
	"imls-pls",
	"nppes",
	"openaddresses",
	"ourairports",
	"state-sources",
	"state-hi-schools",
	"tiger-full",
	"wikidata-subvenue",
] as const satisfies readonly FetchSourceID[]

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fetch",
	description: "Fetch a corpus source",
	positionals: [{ name: "source", required: true, choices: sources, description: "Corpus source ID" }],
	options: {
		"out-root": { type: "string", default: "data/corpus/sources", description: "Destination root" },
		mode: { type: "string", choices: ["featureserver", "bulk"], description: "NAD fetch strategy" },
		"nad-url": { type: "string", description: "NAD bulk URL" },
		"chunk-size": { type: "number", description: "NAD records per output file" },
		"page-size": { type: "number", description: "NAD records per request" },
		concurrency: { type: "number", description: "NAD parallel page fetches" },
		"start-oid": { type: "number", description: "First NAD OBJECTID" },
		"end-oid": { type: "number", description: "Exclusive final NAD OBJECTID" },
		country: { type: "string", description: "OpenAddresses country code" },
		countries: { type: "string", description: "GeoNames postal ISO alpha-2 codes, comma-separated" },
		"skip-state-fips": { type: "string", description: "TIGER state FIPS codes to skip" },
		"rate-sleep": { type: "number", description: "TIGER delay between downloads" },
		"max-parallel": { type: "number", description: "TIGER concurrent downloads" },
		"dry-run": { type: "boolean", default: false, description: "Print planned downloads" },
	},
} as const satisfies CommandSpec

interface Options {
	outRoot: string
	mode?: "featureserver" | "bulk"
	nadUrl?: string
	chunkSize?: number
	pageSize?: number
	concurrency?: number
	startOid?: number
	endOid?: number
	country?: string
	countries?: string
	skipStateFips?: string
	rateSleep?: number
	maxParallel?: number
	dryRun: boolean
}

async function runSource(source: FetchSourceID, options: Options): Promise<FetchSummary> {
	const {
		fetchBan,
		fetchGeonamesDumps,
		fetchGeonamesPostal,
		fetchHRSA,
		fetchIMLSPLS,
		fetchNAD,
		fetchNPPES,
		fetchOpenAddresses,
		fetchOurAirports,
		fetchStateHISchools,
		fetchStateSources,
		fetchTigerFull,
		fetchWikidataSubVenue,
	} = await import("@mailwoman/corpus/tools")

	const base = { outRoot: options.outRoot }

	switch (source) {
		case "ban":
			return fetchBan(base, reportToStderr)
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
				reportToStderr
			)
		case "geonames-dump":
			return fetchGeonamesDumps(
				{
					...base,
					// Undefined = every country the source's own countryInfo.txt catalogs; present dumps are skipped.
					countries: options.countries === undefined ? undefined : splitList(options.countries),
				},
				reportToStderr
			)
		case "geonames-postal":
			return fetchGeonamesPostal(
				{
					...base,
					// Undefined, not an empty list, when the flag is absent — the module's own default set is the answer for
					// 'fetch what the corpus wants', and an empty array would fetch nothing while looking deliberate.
					countries: options.countries === undefined ? undefined : splitList(options.countries),
				},
				reportToStderr
			)
		case "hrsa":
			return fetchHRSA(base, reportToStderr)
		case "imls-pls":
			return fetchIMLSPLS(base, reportToStderr)
		case "nppes":
			return fetchNPPES(base, reportToStderr)
		case "openaddresses":
			return fetchOpenAddresses({ ...base, country: options.country }, reportToStderr)
		case "ourairports":
			return fetchOurAirports(base, reportToStderr)
		case "wikidata-subvenue":
			return fetchWikidataSubVenue(base, reportToStderr)
		case "state-sources":
			return fetchStateSources(base, reportToStderr)
		case "state-hi-schools":
			return fetchStateHISchools(base, reportToStderr)
		case "tiger-full":
			return fetchTigerFull(
				{
					...base,
					skipStateFips: options.skipStateFips,
					rateSleep: options.rateSleep,
					maxParallel: options.maxParallel,
					dryRun: options.dryRun,
				},
				reportToStderr
			)
	}
}

const CorpusFetch: ParsedCommandComponent<Options, [FetchSourceID]> = ({ options, args }) => {
	const state = useCommandTask(
		() => runSource(args[0], options),
		(summary) => (summary.failed > 0 ? 1 : 0)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		const { fetched, skipped, failed, failedCodes } = state.result

		return (
			<Text color={failed > 0 ? "red" : "green"}>
				{args[0]}: fetched {fetched}, skipped {skipped}, failed {failed}
				{failedCodes.length ? ` (${failedCodes.join(" ")})` : ""}
			</Text>
		)
	}

	return null
}

export default CorpusFetch
