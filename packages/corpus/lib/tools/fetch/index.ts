/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Registers the corpus source fetchers, which download raw files and manifests for the adapters to read.
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
 * The fetcher for each source id that `mailwoman corpus fetch` accepts.
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

/**
 * A source id in {@link FETCH_SOURCES}.
 */
export type FetchSourceID = keyof typeof FETCH_SOURCES
