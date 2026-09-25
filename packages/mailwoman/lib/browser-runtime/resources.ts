/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Defines browser asset URLs, version pins, data credits and FST loaders.
 *
 *   The CDN caches assets as immutable, so every rebuild publishes to a new dated path. The version
 *   constants in this module select which path the runtime loads.
 */

import { fetchWithRetry } from "#browser-runtime/fetch"
import type { FSTMatcherLike, FSTProvenanceLike } from "#browser-runtime/types"

/**
 * Public asset origin.
 * It supports byte-range reads of the databases.
 */
const ASSET_BASE_URL = "https://public.mailwoman.ai/mailwoman/"

/**
 * Returns the URL of one file in a locale's release.
 */
export function assetURL(locale: string, version: string, filename: string): string {
	return `${ASSET_BASE_URL}${locale}/${version}/${filename}`
}

/**
 * The publisher credit and license URL for a fetched dataset.
 */
export interface DataCredit {
	publisher: string
	/**
	 * URL of the license or attribution terms.
	 */
	termsURL: string
	/**
	 * A description of the artifacts that the credit covers.
	 */
	artifacts: string
}

/**
 * Publisher credits for the runtime's fetched data.
 * Basemap attribution is handled elsewhere.
 */
export const DATA_CREDITS: readonly DataCredit[] = [
	{
		publisher: "Who's On First",
		termsURL: "https://whosonfirst.org/docs/licenses/",
		artifacts: "the admin gazetteer",
	},
	{
		publisher: "GeoNames",
		termsURL: "https://creativecommons.org/licenses/by/4.0/",
		artifacts: "the admin gazetteer",
	},
	{
		publisher: "Overture Maps Foundation",
		termsURL: "https://docs.overturemaps.org/attribution/",
		artifacts: "the POI layer",
	},
	{
		publisher: "United States Department of Transportation",
		termsURL: "https://www.transportation.gov/gis/national-address-database/national-address-database-nad-disclaimer",
		artifacts: "the US address-point extracts, whose National Address Database rows are 68.2% of them",
	},
	{
		publisher: "United States Census Bureau",
		termsURL: "https://www.census.gov/programs-surveys/geography/about/terms-of-use.html",
		artifacts: "the US interpolation extracts",
	},
	{
		publisher: "OpenAddresses",
		termsURL: "https://openaddresses.io/",
		artifacts: "the US address-point extracts, 31.5% of them from 119 county and state bodies",
	},
	{
		publisher: "DINUM and IGN, for Base Adresse Nationale",
		termsURL: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
		artifacts: "the French address-point extract",
	},
]

/**
 * Returns the URL of a locale's releases manifest.
 */
export function releasesManifestURL(locale: string): string {
	return `${ASSET_BASE_URL}${locale}/releases.json`
}

/**
 * Returns the same-origin path of the sql.js-httpvfs runtime assets.
 */
export function sqljsBaseURL(siteBaseURL: string): string {
	return `${siteBaseURL}mailwoman/sqljs`
}

/**
 * Returns a street-extract URL.
 *
 * National extracts use a dated path, and US state extracts use an undated path.
 */
export function streetExtractURL(slug: string, kind: "situs" | "interp"): string {
	if (NATIONAL_STREET_SLUGS.has(slug)) {
		return `${ASSET_BASE_URL}street/${slug}/${NATIONAL_STREET_EXTRACT_VERSION}/${kind}.db`
	}

	return `${ASSET_BASE_URL}street/us/${slug}/${kind}.db`
}

/**
 * Slugs of the national street extracts.
 */
export const NATIONAL_STREET_SLUGS = new Set(["fr"])

/**
 * Version of the published national street extracts.
 */
export const NATIONAL_STREET_EXTRACT_VERSION = "2026-07-10"

/**
 * The national extract slug used when no US state extract applies.
 */
export const NATIONAL_STREET_FALLBACK_SLUG = "fr"

/**
 * Version of the admin gazetteer, which every model release shares.
 * Update it after uploading a rebuilt gazetteer.
 */
export const ADMIN_GAZETTEER_VERSION = "2026-08-25b"

/**
 * Returns the URL of the global candidate gazetteer, which the runtime reads with byte ranges.
 */
export function adminGazetteerURL(): string {
	return `${ASSET_BASE_URL}gazetteer/${ADMIN_GAZETTEER_VERSION}/candidate.db`
}

/**
 * Version of the POI layer, which every model release shares.
 * Update it after uploading a rebuilt layer.
 */
export const POI_LAYER_VERSION = "2026-07-20a"

/**
 * Returns the URL of the POI layer database.
 */
export function poiLayerURL(): string {
	return `${ASSET_BASE_URL}poi/${POI_LAYER_VERSION}/poi.db`
}

/**
 * US state and territory slugs that have hosted street extracts.
 */
export const HOSTED_STREET_SLUGS = new Set([
	"ak",
	"al",
	"ar",
	"az",
	"ca",
	"co",
	"ct",
	"dc",
	"de",
	"fl",
	"ga",
	"hi",
	"ia",
	"id",
	"il",
	"in",
	"ks",
	"ky",
	"la",
	"ma",
	"md",
	"me",
	"mi",
	"mn",
	"mo",
	"ms",
	"mt",
	"nc",
	"nd",
	"ne",
	"nh",
	"nj",
	"nm",
	"nv",
	"ny",
	"oh",
	"ok",
	"or",
	"pa",
	"ri",
	"sc",
	"sd",
	"tn",
	"tx",
	"ut",
	"va",
	"vi",
	"vt",
	"wa",
	"wi",
	"wv",
	"wy",
])

const US_STATE_NAME_TO_SLUG: Record<string, string> = {
	alabama: "al",
	alaska: "ak",
	arizona: "az",
	arkansas: "ar",
	california: "ca",
	colorado: "co",
	connecticut: "ct",
	delaware: "de",
	"district of columbia": "dc",
	florida: "fl",
	georgia: "ga",
	hawaii: "hi",
	idaho: "id",
	illinois: "il",
	indiana: "in",
	iowa: "ia",
	kansas: "ks",
	kentucky: "ky",
	louisiana: "la",
	maine: "me",
	maryland: "md",
	massachusetts: "ma",
	michigan: "mi",
	minnesota: "mn",
	mississippi: "ms",
	missouri: "mo",
	montana: "mt",
	nebraska: "ne",
	nevada: "nv",
	"new hampshire": "nh",
	"new jersey": "nj",
	"new mexico": "nm",
	"new york": "ny",
	"north carolina": "nc",
	"north dakota": "nd",
	ohio: "oh",
	oklahoma: "ok",
	oregon: "or",
	pennsylvania: "pa",
	"rhode island": "ri",
	"south carolina": "sc",
	"south dakota": "sd",
	tennessee: "tn",
	texas: "tx",
	utah: "ut",
	vermont: "vt",
	virginia: "va",
	washington: "wa",
	"west virginia": "wv",
	wisconsin: "wi",
	wyoming: "wy",
}

/**
 * Converts a US state name or two-letter code to its extract slug.
 * Any two-letter input passes through unchanged.
 */
export function regionToStateSlug(region: string | undefined): string | null {
	if (!region) return null
	const r = region.trim().toLowerCase()

	if (/^[a-z]{2}$/.test(r)) return r

	return US_STATE_NAME_TO_SLUG[r] ?? null
}

/**
 * Returns the loader URL configuration shared by the primary and comparison classifiers.
 */
export function neuralClassifierLoadURLs(
	locale: string,
	version: string,
	opts: { hasAnchor?: boolean; forceWASM: boolean }
) {
	return {
		modelURL: assetURL(locale, version, "model.onnx"),
		tokenizerURL: assetURL(locale, version, "tokenizer.model"),
		modelCardURL: assetURL(locale, version, "model-card.json"),
		// Gazetteer-trained bundles require the lexicon.
		// Older releases may not include it.
		gazetteerLexiconURL: assetURL(locale, version, "anchor-lexicon-v1.json"),
		runner: { useWebGPU: !opts.forceWASM },
		...(opts.hasAnchor
			? {
					postcodeBinaryURLs: [
						assetURL(locale, version, "postcode-us.bin"),
						assetURL(locale, version, "postcode-de.bin"),
						assetURL(locale, version, "postcode-fr.bin"),
					],
				}
			: {}),
	}
}

/**
 * Countries whose placetype-pair indexes the demo requests.
 * The demo skips missing files.
 */
export const PAIR_INDEX_COUNTRIES = ["gb", "nz"] as const

/**
 * Version of the pair-index binaries.
 * Update it with each rebuild.
 *
 * The site pins this version because its bundled reader accepts only one schema version.
 */
export const PAIR_INDEX_VERSION = "2026-08-05"

/**
 * Returns the base URL of one pair-index version.
 */
export function pairIndexBaseURL(version: string): string {
	return `${ASSET_BASE_URL}pair-index/${version}`
}

/**
 * Returns the per-country binary URLs under a pair-index base URL.
 *
 * @param baseURL Base URL of the binaries, with or without a trailing slash.
 */
export function pairIndexURLs(baseURL: string): string[] {
	const base = baseURL.replace(/\/$/, "")

	return PAIR_INDEX_COUNTRIES.map((cc) => `${base}/pair-index-${cc}.bin`)
}

/**
 * Loads the release's FST gazetteer and, when the binary includes it, its provenance.
 */
export async function loadFSTGazetteer(
	locale: string,
	version: string
): Promise<{ matcher: FSTMatcherLike; provenance?: FSTProvenanceLike }> {
	const [fstModule, fstBinary] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web"),
		fetchWithRetry(assetURL(locale, version, "fst-en-US.bin")).then((r) => {
			if (!r.ok) throw new Error(`FST fetch failed (${r.status})`)

			return r.arrayBuffer()
		}),
	])

	const matcher = fstModule.deserializeFSTWeb(fstBinary) as FSTMatcherLike
	let provenance: FSTProvenanceLike | undefined

	try {
		provenance = fstModule.readFSTProvenanceWeb(fstBinary) as FSTProvenanceLike | undefined
	} catch {
		// Version 2 binaries have no provenance section.
	}

	return { matcher, provenance }
}

/**
 * Loads the release's street-morphology FST.
 *
 * The function returns `null` when the file is unavailable and throws when the binary is corrupt.
 */
export async function loadStreetMorphologyFST(locale: string, version: string): Promise<FSTMatcherLike | null> {
	const res = await fetchWithRetry(assetURL(locale, version, "fst-street-morphology.bin"))

	if (!res.ok) return null
	const fstModule = await import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web")

	return fstModule.deserializeFSTWeb(await res.arrayBuffer()) as FSTMatcherLike
}
