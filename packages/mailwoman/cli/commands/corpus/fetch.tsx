/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus fetch <source>` — reproducible bulk-download of the open-data sources the corpus
 *   build consumes. Each source writes its raw files plus a sibling `manifest.json` (origin URL,
 *   timestamp, byte count, sha256).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import type { FetchSourceID, FetchSummary } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import { PathBuilder } from "path-ts"

import {
	type CommandSpec,
	CommandTaskResult,
	type CommandComponent,
	type OptionsOf,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

const sources = [
	"acra-sg",
	"ads-ee",
	"ban",
	"bd-adresses",
	"brussels",
	"cordis",
	"cz-cuzk",
	"dk-inspire",
	"emuia-pl",
	"es-bizkaia",
	"es-catastro",
	"es-gipuzkoa",
	"es-navarra",
	"fr-annuaire-education-overseas",
	"fr-finess-overseas",
	"gcis-tw",
	"gleif",
	"houjin-jp",
	"it-anac",
	"juso-kr",
	"localdata-kr",
	"lv-varis",
	"matrikkelen",
	"nad",
	"nl-kadaster",
	"ro-retea-scolara",
	"ryhti",
	"sk-inspire",
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
	"vlaanderen",
	"wallonie",
	"wikidata-subvenue",
] as const satisfies readonly FetchSourceID[]

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "fetch",
	description: "Fetch a corpus source",
	positionals: [{ name: "source", required: true, choices: sources, description: "Corpus source ID" }],
	options: {
		// A fetched source is a data-root artifact, and `corpus build`'s manifest resolves every
		// `inputPath` against `$MAILWOMAN_DATA_ROOT`, so the default writes where the build reads.
		// The previous default, `data/corpus/sources`, sat inside a tracked repository directory with
		// no ignore rule covering it, so one `corpus fetch ban` left 4.6 GB in the working tree.
		"out-root": {
			type: "string",
			default: dataRootPath("corpus", "sources").toString(),
			description: "Destination root, under the data root unless this names another",
		},
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
		month: { type: "string", description: "juso-kr month as YYYYMM (default: the latest listed)" },
		categories: { type: "string", description: "localdata-kr category slugs, comma-separated (default: all)" },
		editions: {
			type: "string",
			description: "it-anac editions, comma-separated: a year, undated, or full (default: full)",
		},
		provinces: {
			type: "string",
			description: "es-catastro two-digit province codes, comma-separated (default: all 52)",
		},
		municipalities: {
			type: "string",
			description: "es-catastro five-digit municipality codes, comma-separated, within the provinces selected",
		},
		partitions: { type: "string", description: "es-navarra partition numbers, comma-separated (default: all)" },
		areas: {
			type: "string",
			description: "matrikkelen Geonorge area codes, comma-separated: 0000 and 2100 (default: both)",
		},
		limit: { type: "number", description: "es-catastro and es-navarra: stop after this many archives" },
	},
} as const satisfies CommandSpec

type Options = OptionsOf<typeof spec>

async function runSource(source: FetchSourceID, options: Options): Promise<FetchSummary> {
	const {
		fetchACRASG,
		fetchADSEE,
		fetchBan,
		fetchBDAdresses,
		fetchBrussels,
		fetchCORDIS,
		fetchAnnuaireEducationOverseas,
		fetchFinessOverseas,
		fetchGLEIF,
		fetchVaris,
		fetchVlaanderenAD,
		fetchWallonie,
		fetchCzCuzk,
		fetchDKAddresses,
		fetchEMUiAPL,
		fetchESBizkaia,
		fetchESCatastro,
		fetchESGipuzkoa,
		fetchESNavarra,
		fetchGCISTW,
		fetchGeonamesDumps,
		fetchGeonamesPostal,
		fetchHoujinJP,
		fetchHRSA,
		fetchIMLSPLS,
		fetchITANAC,
		fetchJusoKR,
		fetchLocaldataKR,
		fetchMatrikkelen,
		fetchNAD,
		fetchNLKadaster,
		fetchNPPES,
		fetchOpenAddresses,
		fetchOurAirports,
		fetchReteaScolara,
		fetchRyhti,
		fetchSKInspire,
		fetchStateHISchools,
		fetchStateSources,
		fetchTigerFull,
		fetchWikidataSubVenue,
	} = await import("@mailwoman/corpus/tools")

	const base = { outRoot: PathBuilder.from(options.outRoot) }

	switch (source) {
		case "acra-sg":
			return fetchACRASG(base, reportToStderr)
		case "ads-ee":
			return fetchADSEE(base, reportToStderr)
		case "bd-adresses":
			return fetchBDAdresses(base, reportToStderr)
		case "brussels":
			return fetchBrussels(base, reportToStderr)
		case "cordis":
			return fetchCORDIS(base, reportToStderr)
		case "lv-varis":
			return fetchVaris(base, reportToStderr)
		case "fr-annuaire-education-overseas":
			return fetchAnnuaireEducationOverseas(base, reportToStderr)
		case "fr-finess-overseas":
			return fetchFinessOverseas(base, reportToStderr)
		case "gleif":
			return fetchGLEIF(base, reportToStderr)
		case "ro-retea-scolara":
			return fetchReteaScolara(base, reportToStderr)
		case "vlaanderen":
			return fetchVlaanderenAD(base, reportToStderr)
		case "wallonie":
			return fetchWallonie(base, reportToStderr)
		case "cz-cuzk":
			return fetchCzCuzk(base, reportToStderr)
		case "dk-inspire":
			return fetchDKAddresses(base, reportToStderr)
		case "emuia-pl":
			return fetchEMUiAPL(base, reportToStderr)
		case "es-bizkaia":
			return fetchESBizkaia(base, reportToStderr)
		case "es-catastro":
			return fetchESCatastro(
				{
					...base,
					provinces: options.provinces ? extractDelimited(options.provinces) : undefined,
					municipalities: options.municipalities ? extractDelimited(options.municipalities) : undefined,
					limit: options.limit,
				},
				reportToStderr
			)
		case "es-gipuzkoa":
			return fetchESGipuzkoa(base, reportToStderr)
		case "es-navarra":
			return fetchESNavarra(
				{
					...base,
					partitions: options.partitions ? extractDelimited(options.partitions) : undefined,
					limit: options.limit,
				},
				reportToStderr
			)
		case "matrikkelen":
			return fetchMatrikkelen(
				{
					...base,
					// Undefined takes both areas the address-source register holds rows for,
					// `0000` for the mainland and `2100` for Svalbard.
					areas: options.areas ? extractDelimited(options.areas) : undefined,
				},
				reportToStderr
			)
		case "nl-kadaster":
			return fetchNLKadaster(base, reportToStderr)
		case "sk-inspire":
			return fetchSKInspire(base, reportToStderr)
		case "ryhti":
			return fetchRyhti(base, reportToStderr)
		case "gcis-tw":
			return fetchGCISTW(base, reportToStderr)
		case "houjin-jp":
			return fetchHoujinJP(base, reportToStderr)
		case "it-anac":
			return fetchITANAC(
				{ ...base, editions: options.editions ? extractDelimited(options.editions) : undefined },
				reportToStderr
			)
		case "juso-kr":
			return fetchJusoKR({ ...base, month: options.month }, reportToStderr)
		case "localdata-kr":
			return fetchLocaldataKR(
				{ ...base, categories: options.categories ? extractDelimited(options.categories) : undefined },
				reportToStderr
			)
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
					// Undefined means every country the source's own countryInfo.txt catalogs.
					// Present dumps are skipped.
					countries: options.countries ? extractDelimited(options.countries) : undefined,
				},
				reportToStderr
			)
		case "geonames-postal":
			return fetchGeonamesPostal(
				{
					...base,
					// Undefined rather than an empty list when the flag is absent:
					// the module's own default set is the answer for "fetch what the corpus wants",
					// and an empty array would fetch no countries while looking deliberate.
					countries: options.countries ? extractDelimited(options.countries) : undefined,
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

const CorpusFetch: CommandComponent<typeof spec, [FetchSourceID]> = ({ options, args }) => {
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
