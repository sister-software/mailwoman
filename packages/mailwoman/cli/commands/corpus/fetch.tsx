/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus fetch <source>` — reproducible bulk-download of the open-data sources the corpus
 *   build consumes. Each source writes its raw files plus a sibling `manifest.json` (origin URL,
 *   timestamp, byte count, sha256).
 */

import { currentSourcePath } from "@mailwoman/core/data-root"
import { allKeyed } from "@mailwoman/core/promises"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import type { FetchSourceID } from "@mailwoman/corpus/tools/fetch"
import type { FetchSummary } from "@mailwoman/corpus/tools/fetch/download/network"
import type { FetchDestinations } from "@mailwoman/corpus/tools/fetch/storage"
import { Text } from "ink"

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
	"gb-os-open",
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
	"wikidata-vital-places",
] as const satisfies readonly FetchSourceID[]

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "fetch",
	description: "Fetch a corpus source",
	positionals: [{ name: "source", required: true, choices: sources, description: "Corpus source ID" }],
	options: {
		// Each source writes by its storage class (`@mailwoman/corpus/tools/fetch/storage`):
		// a current source under `$MAILWOMAN_CACHE_ROOT/sources/<source>/`, a snapshot
		// under `$MAILWOMAN_DATA_ROOT/snapshots/<source>/<vintage>/`.
		"out-root": {
			type: "string",
			description:
				"One root for both classes: a current source writes <root>/<source>/ and a snapshot <root>/<source>/<vintage>/ (default: the cache root's sources/ and the data root's snapshots/)",
		},
		vintage: {
			type: "string",
			description:
				"Snapshot sources: the vintage to write, such as 2026-08 (default: the one the publisher serves); juso-kr fetches the month it names",
		},
		force: {
			type: "boolean",
			default: false,
			description: "Snapshot sources: replace the vintage --vintage names when it already exists",
		},
		"nad-url": { type: "string", description: "NAD release archive link (default: DOT's open-data portal link)" },
		concurrency: {
			type: "number",
			description:
				"wikidata-vital-places: entity requests in flight, capped at 1 anonymously and 3 when WIKIDATA_BOT_USERNAME and WIKIDATA_BOT_PASSWORD log in (default: the cap)",
		},
		country: { type: "string", description: "OpenAddresses country code" },
		sources: {
			type: "string",
			description:
				"openaddresses: source members, comma-separated (us/mi/statewide); caches each one's latest batch job output in the cache root's sources/openaddresses instead of a country collection",
		},
		plan: {
			type: "string",
			description:
				"openaddresses: a plan JSON from address-coverage/plan.run.ts; caches each member it lists with a job at the job the plan records",
		},
		countries: { type: "string", description: "GeoNames postal ISO alpha-2 codes, comma-separated" },
		"skip-state-fips": { type: "string", description: "TIGER state FIPS codes to skip" },
		"rate-sleep": { type: "number", description: "TIGER delay between downloads" },
		"max-parallel": { type: "number", description: "TIGER concurrent downloads" },
		"dry-run": { type: "boolean", default: false, description: "Print planned downloads" },
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
		top: { type: "number", description: "wikidata-vital-places: ranked items to describe (default: 50000)" },
		languages: {
			type: "string",
			description: "wikidata-vital-places: label and alias languages, comma-separated (default: ten)",
		},
		batch: {
			type: "number",
			description: "wikidata-vital-places: ids per wbgetentities request, 1 to 50 (default: 10)",
		},
	},
} as const satisfies CommandSpec

type Options = OptionsOf<typeof spec>

/**
 * Where a fetch writes: the current-source root, and the snapshot root with the vintage the caller stated.
 */
type FetchBase = FetchDestinations

/**
 * One source's fetch: it loads that source's module and calls its fetcher with the options it reads.
 */
type SourceFetcher = (base: FetchBase, options: Options) => Promise<FetchSummary>

const delimited = (value: string | undefined): string[] | null => (value ? extractDelimited(value) : null)

/**
 * The fetcher of each source, keyed by source ID.
 *
 * Each entry imports its own module when it runs, so a fetch loads the one source it was asked for.
 * The table states every module the command may load.
 * A computed specifier would leave that list unstated.
 */
const FETCHERS = {
	"acra-sg": async (base) => (await import("@mailwoman/corpus/sg/tools/fetch/acra")).fetchACRASG(base, reportToStderr),
	"ads-ee": async (base) => (await import("@mailwoman/corpus/ee/tools/fetch/ads")).fetchADSEE(base, reportToStderr),
	ban: async (base) => (await import("@mailwoman/corpus/fr/tools/fetch/ban")).fetchBan(base, reportToStderr),
	"bd-adresses": async (base) =>
		(await import("@mailwoman/corpus/lu/tools/fetch/bd-adresses")).fetchBDAdresses(base, reportToStderr),
	brussels: async (base) =>
		(await import("@mailwoman/corpus/be/tools/fetch/brussels")).fetchBrussels(base, reportToStderr),
	cordis: async (base) => (await import("@mailwoman/corpus/tools/fetch/cordis")).fetchCORDIS(base, reportToStderr),
	"cz-cuzk": async (base) => (await import("@mailwoman/corpus/cz/tools/fetch/cuzk")).fetchCzCuzk(base, reportToStderr),
	"dk-inspire": async (base) =>
		(await import("@mailwoman/corpus/dk/tools/fetch/inspire")).fetchDKAddresses(base, reportToStderr),
	"emuia-pl": async (base) =>
		(await import("@mailwoman/corpus/pl/tools/fetch/emuia")).fetchEMUiAPL(base, reportToStderr),
	"es-bizkaia": async (base) =>
		(await import("@mailwoman/corpus/es/tools/fetch/bizkaia")).fetchESBizkaia(base, reportToStderr),
	"es-catastro": async (base, options) =>
		(await import("@mailwoman/corpus/es/tools/fetch/catastro")).fetchESCatastro(
			{
				...base,
				provinces: delimited(options.provinces),
				municipalities: delimited(options.municipalities),
				limit: options.limit,
			},
			reportToStderr
		),
	"es-gipuzkoa": async (base) =>
		(await import("@mailwoman/corpus/es/tools/fetch/gipuzkoa")).fetchESGipuzkoa(base, reportToStderr),
	"es-navarra": async (base, options) =>
		(await import("@mailwoman/corpus/es/tools/fetch/navarra")).fetchESNavarra(
			{ ...base, partitions: delimited(options.partitions), limit: options.limit },
			reportToStderr
		),
	"fr-annuaire-education-overseas": async (base) =>
		(await import("@mailwoman/corpus/fr/tools/fetch/annuaire-education")).fetchAnnuaireEducationOverseas(
			base,
			reportToStderr
		),
	"fr-finess-overseas": async (base) =>
		(await import("@mailwoman/corpus/fr/tools/fetch/finess")).fetchFinessOverseas(base, reportToStderr),
	"gb-os-open": async (base) =>
		(await import("@mailwoman/corpus/gb/tools/fetch/os-open")).fetchGBOSOpen(base, reportToStderr),
	"gcis-tw": async (base) => (await import("@mailwoman/corpus/tw/tools/fetch/gcis")).fetchGCISTW(base, reportToStderr),
	gleif: async (base) => (await import("@mailwoman/corpus/tools/fetch/gleif")).fetchGLEIF(base, reportToStderr),
	"houjin-jp": async (base) =>
		(await import("@mailwoman/corpus/jp/tools/fetch/houjin")).fetchHoujinJP(base, reportToStderr),
	"it-anac": async (base, options) =>
		(await import("@mailwoman/corpus/it/tools/fetch/anac")).fetchITANAC(
			{ ...base, editions: delimited(options.editions) },
			reportToStderr
		),
	"juso-kr": async (base) => (await import("@mailwoman/corpus/kr/tools/fetch/juso")).fetchJusoKR(base, reportToStderr),
	"localdata-kr": async (base, options) =>
		(await import("@mailwoman/corpus/kr/tools/fetch/localdata")).fetchLocaldataKR(
			{ ...base, categories: delimited(options.categories) },
			reportToStderr
		),
	"lv-varis": async (base) => (await import("@mailwoman/corpus/lv/tools/fetch/varis")).fetchVaris(base, reportToStderr),
	// Null takes both areas the address-source register holds rows for, `0000` for the mainland and `2100` for Svalbard.
	matrikkelen: async (base, options) =>
		(await import("@mailwoman/corpus/no/tools/fetch/matrikkelen")).fetchMatrikkelen(
			{ ...base, areas: delimited(options.areas) },
			reportToStderr
		),
	nad: async (base, options) =>
		(await import("@mailwoman/corpus/us/tools/fetch/nad")).fetchNAD(
			{ ...base, nadURL: options.nadUrl },
			reportToStderr
		),
	"nl-kadaster": async (base) =>
		(await import("@mailwoman/corpus/nl/tools/fetch/kadaster")).fetchNLKadaster(base, reportToStderr),
	"ro-retea-scolara": async (base) =>
		(await import("@mailwoman/corpus/ro/tools/fetch/retea-scolara")).fetchReteaScolara(base, reportToStderr),
	ryhti: async (base) => (await import("@mailwoman/corpus/fi/tools/fetch/ryhti")).fetchRyhti(base, reportToStderr),
	"sk-inspire": async (base) =>
		(await import("@mailwoman/corpus/sk/tools/fetch/inspire")).fetchSKInspire(base, reportToStderr),
	// Null means every country the source's own countryInfo.txt catalogs.
	// Present dumps are skipped.
	"geonames-dump": async (base, options) =>
		(await import("@mailwoman/corpus/tools/fetch/geonames/dump")).fetchGeonamesDumps(
			{
				...base,
				// The dump fetcher writes `<CC>.txt` straight into its root, beside any hand-fetched
				// GeoNames files there, so its default root is its own current-source directory.
				outRoot: options.outRoot ? base.outRoot : currentSourcePath("geonames-dump"),
				countries: delimited(options.countries),
			},
			reportToStderr
		),
	// Null when the flag is absent takes the module's own default set, the countries the corpus wants.
	// An empty array would fetch no countries while looking deliberate.
	"geonames-postal": async (base, options) =>
		(await import("@mailwoman/corpus/tools/fetch/geonames/postal")).fetchGeonamesPostal(
			{ ...base, countries: delimited(options.countries) },
			reportToStderr
		),
	hrsa: async (base) => (await import("@mailwoman/corpus/us/tools/fetch/hrsa")).fetchHRSA(base, reportToStderr),
	"imls-pls": async (base) =>
		(await import("@mailwoman/corpus/us/tools/fetch/imls-pls")).fetchIMLSPLS(base, reportToStderr),
	nppes: async (base) => (await import("@mailwoman/corpus/us/tools/fetch/nppes")).fetchNPPES(base, reportToStderr),
	openaddresses: async (base, options) => {
		const { openaddresses, readers } = await allKeyed({
			openaddresses: import("@mailwoman/corpus/tools/fetch/openaddresses"),
			readers: import("@mailwoman/core/fs/readers"),
		})

		const planned = options.plan
			? (
					await readers.readLocalJSONFile<Array<{ member: string; job: number | null; updated: string | null }>>(
						options.plan
					)
				)
					.filter((entry) => entry.job != null)
					.map(({ member, job, updated }) => ({ member, job, updated }))
			: null

		return openaddresses.fetchOpenAddresses(
			{
				...base,
				country: options.country,
				sources: planned ?? delimited(options.sources)?.map((member) => ({ member })) ?? null,
			},
			reportToStderr
		)
	},
	ourairports: async (base) =>
		(await import("@mailwoman/corpus/tools/fetch/ourairports")).fetchOurAirports(base, reportToStderr),
	"state-sources": async (base) =>
		(await import("@mailwoman/corpus/us/tools/fetch/state/sources")).fetchStateSources(base, reportToStderr),
	"state-hi-schools": async (base) =>
		(await import("@mailwoman/corpus/us/tools/fetch/state/hi-schools")).fetchStateHISchools(base, reportToStderr),
	"tiger-full": async (base, options) =>
		(await import("@mailwoman/corpus/us/tools/fetch/tiger-full")).fetchTigerFull(
			{
				...base,
				skipStateFips: options.skipStateFips,
				rateSleep: options.rateSleep,
				maxParallel: options.maxParallel,
				dryRun: options.dryRun,
			},
			reportToStderr
		),
	vlaanderen: async (base) =>
		(await import("@mailwoman/corpus/tools/fetch/vlaanderen-ad")).fetchVlaanderenAD(base, reportToStderr),
	wallonie: async (base) =>
		(await import("@mailwoman/corpus/be/tools/fetch/wallonie")).fetchWallonie(base, reportToStderr),
	"wikidata-subvenue": async (base) =>
		(await import("@mailwoman/corpus/tools/fetch/wikidata/subvenue")).fetchWikidataSubVenue(base, reportToStderr),
	// Null languages take the module's own ten.
	"wikidata-vital-places": async (base, options) =>
		(await import("@mailwoman/corpus/tools/fetch/wikidata/vital-places")).fetchWikidataVitalPlaces(
			{
				...base,
				top: options.top,
				languages: delimited(options.languages),
				batchSize: options.batch,
				concurrency: options.concurrency,
			},
			reportToStderr
		),
} as const satisfies Record<(typeof sources)[number], SourceFetcher>

async function runSource(source: (typeof sources)[number], options: Options): Promise<FetchSummary> {
	const { resolveFetchDestinations } = await import("@mailwoman/corpus/tools/fetch/storage")

	const base = resolveFetchDestinations(source, {
		outRoot: options.outRoot,
		vintage: options.vintage,
		force: options.force,
	})

	return FETCHERS[source](base, options)
}

const CorpusFetch: CommandComponent<typeof spec, [(typeof sources)[number]]> = ({ options, args }) => {
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
