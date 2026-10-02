/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Registers the corpus source fetchers. They download raw files and manifests for the adapters to read.
 */

import { fetchCzCuzk } from "#cz/tools/fetch/cuzk"
import { fetchDKAddresses } from "#dk/tools/fetch/inspire"
import { fetchADSEE } from "#ee/tools/fetch/ads"
import { fetchRyhti } from "#fi/tools/fetch/ryhti"
import { fetchBan } from "#fr/tools/fetch/ban"
import { fetchITANAC } from "#it/tools/fetch/anac"
import { fetchHoujinJP } from "#jp/tools/fetch/houjin"
import { fetchJusoKR } from "#kr/tools/fetch/juso"
import { fetchLocaldataKR } from "#kr/tools/fetch/localdata"
import { fetchBDAdresses } from "#lu/tools/fetch/bd-adresses"
import { fetchEMUiAPL } from "#pl/tools/fetch/emuia"
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
export * from "#ee/tools/fetch/ads"
export * from "#it/tools/fetch/anac"
export * from "#fr/tools/fetch/ban"
export * from "#lu/tools/fetch/bd-adresses"
export * from "#cz/tools/fetch/cuzk"
export * from "#pl/tools/fetch/emuia"
export * from "#dk/tools/fetch/inspire"
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
export * from "#fi/tools/fetch/ryhti"
export * from "#us/tools/fetch/state/hi-schools"
export * from "#us/tools/fetch/state/sources"
export * from "#us/tools/fetch/tiger-full"
export * from "#tools/fetch/wikidata-subvenue"

/**
 * The fetcher for each source id that `mailwoman corpus fetch` accepts.
 */
export const FETCH_SOURCES = {
	"acra-sg": fetchACRASG,
	"ads-ee": fetchADSEE,
	ban: fetchBan,
	"bd-adresses": fetchBDAdresses,
	"cz-cuzk": fetchCzCuzk,
	"dk-inspire": fetchDKAddresses,
	"emuia-pl": fetchEMUiAPL,
	"gcis-tw": fetchGCISTW,
	"houjin-jp": fetchHoujinJP,
	"it-anac": fetchITANAC,
	"juso-kr": fetchJusoKR,
	"localdata-kr": fetchLocaldataKR,
	nad: fetchNAD,
	ryhti: fetchRyhti,
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
