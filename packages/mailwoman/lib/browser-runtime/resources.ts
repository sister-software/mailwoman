/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser asset URLs, version pins, attribution data, and FST loaders. Assets use immutable caching; rebuilds require
 *   new dated paths, with these constants serving as the mutable pointers.
 */

import { fetchWithRetry } from "#browser-runtime/fetch"
import type { FSTMatcherLike, FSTProvenanceLike } from "#browser-runtime/types"

/**
 * Public asset origin.
 * Databases support byte-range reads from this host.
 */
const ASSET_BASE_URL = "https://public.mailwoman.ai/mailwoman/"

export function assetURL(locale: string, version: string, filename: string): string {
	return `${ASSET_BASE_URL}${locale}/${version}/${filename}`
}

/**
 * Publisher credit and license URL for a fetched dataset.
 * Basemap attribution is handled separately.
 */
export interface DataCredit {
	/**
	 * Publisher name.
	 */
	publisher: string
	/**
	 * URL for the license or attribution terms.
	 */
	termsURL: string
	/**
	 * Artifacts covered by this credit.
	 */
	artifacts: string
}

/**
 * Publisher credits for the runtime's fetched data, excluding the basemap.
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
 * URL of the per-locale releases manifest.
 */
export function releasesManifestURL(locale: string): string {
	return `${ASSET_BASE_URL}${locale}/releases.json`
}

/**
 * Same-origin path for sql.js-httpvfs runtime assets.
 */
export function sqljsBaseURL(siteBaseURL: string): string {
	return `${siteBaseURL}mailwoman/sqljs`
}

/**
 * Build a street-extract URL.
 *
 * US extracts are state-specific; national extracts use a dated path.
 */
export function streetExtractURL(slug: string, kind: "situs" | "interp"): string {
	// National extracts use dated URLs; US extracts use the state-specific path.
	if (NATIONAL_STREET_SLUGS.has(slug)) {
		return `${ASSET_BASE_URL}street/${slug}/${NATIONAL_STREET_EXTRACT_VERSION}/${kind}.db`
	}

	return `${ASSET_BASE_URL}street/us/${slug}/${kind}.db`
}

/**
 * National street extracts, currently available for France.
 */
export const NATIONAL_STREET_SLUGS = new Set(["fr"])

/**
 * Version of the published national street extract.
 */
export const NATIONAL_STREET_EXTRACT_VERSION = "2026-07-10"

/**
 * National fallback slug when no US state extract applies.
 */
export const NATIONAL_STREET_FALLBACK_SLUG = "fr"

/**
 * Version for the model-independent admin gazetteer.
 * Bump it when the artifact is rebuilt and uploaded.
 */
export const ADMIN_GAZETTEER_VERSION = "2026-08-25b"

/**
 * Build the dated URL for the global, byte-ranged candidate gazetteer.
 */
export function adminGazetteerURL(): string {
	return `${ASSET_BASE_URL}gazetteer/${ADMIN_GAZETTEER_VERSION}/candidate.db`
}

/**
 * Version of the model-independent POI layer.
 * Bump it when the artifact is rebuilt and uploaded.
 */
export const POI_LAYER_VERSION = "2026-07-20a"

export function poiLayerURL(): string {
	return `${ASSET_BASE_URL}poi/${POI_LAYER_VERSION}/poi.db`
}

/**
 * US state and territory slugs with hosted street extracts.
 * Other regions use the gazetteer fallback.
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
 * Convert a recognized US region name or abbreviation to its extract slug.
 */
export function regionToStateSlug(region: string | undefined): string | null {
	if (!region) return null
	const r = region.trim().toLowerCase()

	if (/^[a-z]{2}$/.test(r)) return r

	// Accept two-letter abbreviations directly.
	return US_STATE_NAME_TO_SLUG[r] ?? null
}

/**
 * Build the URL configuration shared by the primary and comparison classifier loaders.
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
		// Required by gazetteer-trained bundles; older releases may omit it.
		gazetteerLexiconURL: assetURL(locale, version, "anchor-lexicon-v1.json"),
		runner: { useWebGPU: !opts.forceWASM },
		// Include postcode anchors when the release has them.
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
 * Countries whose placetype-pair indexes the demo requests; missing files are skipped.
 */
export const PAIR_INDEX_COUNTRIES = ["gb", "nz"] as const

/**
 * Versioned pair-index path.
 *
 * Bump alongside binary rebuilds because CDN assets are immutable.
 * This pin belongs to the deployed site because its bundled reader enforces a schema version.
 */
export const PAIR_INDEX_VERSION = "2026-08-05"

/**
 * Return the base URL for a pair-index generation.
 */
export function pairIndexBaseURL(version: string): string {
	return `${ASSET_BASE_URL}pair-index/${version}`
}

/**
 * Build the country binary URLs under a pair-index base.
 *
 * @param baseURL Base for the binaries — a trailing slash is tolerated.
 */
export function pairIndexURLs(baseURL: string): string[] {
	const base = baseURL.replace(/\/$/, "")

	return PAIR_INDEX_COUNTRIES.map((cc) => `${base}/pair-index-${cc}.bin`)
}

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
		/* V2 binary — no provenance */
	}

	return { matcher, provenance }
}

/**
 * Load the release's street-morphology FST.
 *
 * Return `null` when the artifact is unavailable; corrupt binaries throw.
 */
export async function loadStreetMorphologyFST(locale: string, version: string): Promise<FSTMatcherLike | null> {
	const res = await fetchWithRetry(assetURL(locale, version, "fst-street-morphology.bin"))

	if (!res.ok) return null
	const fstModule = await import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web")

	return fstModule.deserializeFSTWeb(await res.arrayBuffer()) as FSTMatcherLike
}
