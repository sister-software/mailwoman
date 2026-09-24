/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Register reproducible downloads for corpus sources. Fetchers write raw files and manifests; adapters consume those
 * files separately. Operators download data before building a corpus and can use these commands for refreshes,
 * recovery, or new-environment setup.
 *
 * Source and license details belong with each fetcher and adapter. OpenAddresses is license-mixed: its adapter filters
 * out restricted rows by default. See `docs/licensing-strategy.md` for tier definitions.
 *
 * OpenAddresses bulk downloads require a free account. `fetchOpenAddresses` reads `OA_BATCH_TOKEN`; without it, the
 * command prints setup instructions. Register at `https://batch.openaddresses.io/register` and provide the token via
 * the environment.
 *
 * To add a source, register its slug, filename, and URL; verify the URL and manifest with a scratch output directory;
 * then add or update its corpus adapter.
 *
 * Usage:
 *
 * ```sh
 * mailwoman corpus fetch state-sources
 * mailwoman corpus fetch hrsa --out-root /data/corpus/sources
 * mailwoman corpus fetch openaddresses --country ca --out-root "$MAILWOMAN_DATA_ROOT/corpus/sources"
 * ```
 */

import { fetchBan } from "#fr/tools/fetch/ban"
import { fetchHoujinJP } from "#jp/tools/fetch/houjin"
import { fetchJusoKR } from "#kr/tools/fetch/juso"
import { fetchLocaldataKR } from "#kr/tools/fetch/localdata"
import { fetchACRASG } from "#sg/tools/fetch/acra"
import { fetchGeonamesDumps } from "#tools/fetch/geonames/dump"
import { fetchGeonamesPostal } from "#tools/fetch/geonames/postal"
import { fetchOpenAddresses } from "#tools/fetch/openaddresses"
import { fetchOurAirports } from "#tools/fetch/ourairports"
import { fetchWikidataSubVenue } from "#tools/fetch/wikidata-subvenue"
import { fetchGCISTW } from "#tw/tools/fetch/gcis"
import { fetchHRSA } from "#us/tools/fetch/hrsa"
import { fetchIMLSPLS } from "#us/tools/fetch/imls-pls"
import { fetchNAD } from "#us/tools/fetch/nad"
import { fetchNPPES } from "#us/tools/fetch/nppes"
import { fetchStateHISchools } from "#us/tools/fetch/state/hi-schools"
import { fetchStateSources } from "#us/tools/fetch/state/sources"
import { fetchTigerFull } from "#us/tools/fetch/tiger-full"

export * from "#sg/tools/fetch/acra"
export * from "#fr/tools/fetch/ban"
export * from "#tw/tools/fetch/gcis"
export * from "#tools/fetch/geonames/dump"
export * from "#tools/fetch/geonames/postal"
export * from "#jp/tools/fetch/houjin"
export * from "#us/tools/fetch/hrsa"
export * from "#us/tools/fetch/imls-pls"
export * from "#kr/tools/fetch/juso"
export * from "#kr/tools/fetch/localdata"
export * from "#us/tools/fetch/nad"
export * from "#us/tools/fetch/nppes"
export * from "#tools/fetch/openaddresses"
export * from "#tools/fetch/ourairports"
export * from "#us/tools/fetch/state/hi-schools"
export * from "#us/tools/fetch/state/sources"
export * from "#us/tools/fetch/tiger-full"
export * from "#tools/fetch/wikidata-subvenue"

/**
 * Map source IDs to their fetcher entry points.
 */
export const FETCH_SOURCES = {
	"acra-sg": fetchACRASG,
	ban: fetchBan,
	"gcis-tw": fetchGCISTW,
	"houjin-jp": fetchHoujinJP,
	"juso-kr": fetchJusoKR,
	"localdata-kr": fetchLocaldataKR,
	nad: fetchNAD,
	"geonames-dump": fetchGeonamesDumps,
	"geonames-postal": fetchGeonamesPostal,
	hrsa: fetchHRSA,
	"imls-pls": fetchIMLSPLS,
	nppes: fetchNPPES,
	openaddresses: fetchOpenAddresses,
	ourairports: fetchOurAirports,
	"state-sources": fetchStateSources,
	"state-hi-schools": fetchStateHISchools,
	"tiger-full": fetchTigerFull,
	"wikidata-subvenue": fetchWikidataSubVenue,
} as const

export type FetchSourceID = keyof typeof FETCH_SOURCES
