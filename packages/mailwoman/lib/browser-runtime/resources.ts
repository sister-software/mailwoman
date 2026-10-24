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

import type { FSTProvenance } from "@mailwoman/core/pipeline/client-result"

import { fetchWithRetry } from "#browser-runtime/fetch"
import type { FSTMatcherLike } from "#browser-runtime/types"

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
 * Returns the same-origin path of the staged range worker and sqlite-wasm runtime.
 */
export function sqliteRuntimeBaseURL(siteBaseURL: string): string {
	return `${siteBaseURL}mailwoman/sqlite`
}

/**
 * Returns a street-extract URL.
 *
 * National extracts and US state interpolation extracts use a dated path.
 * US state situs extracts use an undated path.
 */
export function streetExtractURL(slug: string, kind: "situs" | "interp"): string {
	if (NATIONAL_STREET_SLUGS.has(slug)) {
		return `${ASSET_BASE_URL}street/${slug}/${NATIONAL_STREET_EXTRACT_VERSION}/${kind}.db`
	}

	if (kind === "interp") {
		return `${ASSET_BASE_URL}street/us/${slug}/${US_INTERPOLATION_EXTRACT_VERSION}/interp.db`
	}

	return `${ASSET_BASE_URL}street/us/${slug}/${kind}.db`
}

/**
 * Version of the published US state interpolation extracts.
 *
 * The browser caches range chunks by URL and offset, so a rebuilt extract is published
 * under a new version and never over an existing URL.
 * Update it after uploading rebuilt extracts.
 */
export const US_INTERPOLATION_EXTRACT_VERSION = "2026-10-02"

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
 * Version of the admin gazetteer.
 *
 * Every model release shares it.
 * Update it after uploading a rebuilt gazetteer.
 */
export const ADMIN_GAZETTEER_VERSION = "2026-08-25b"

/**
 * Returns the URL of the global candidate gazetteer.
 * The runtime reads it with byte ranges.
 */
export function adminGazetteerURL(): string {
	return `${ASSET_BASE_URL}gazetteer/${ADMIN_GAZETTEER_VERSION}/candidate.db`
}

/**
 * Version of the POI layer.
 *
 * Every model release shares it.
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
 * Version of the place autocomplete index, one sealed ancestrie per leading character of the folded name.
 *
 * Update it after publishing a generation built by `autocomplete-index.run.ts`.
 */
export const AUTOCOMPLETE_INDEX_VERSION = "2026-10-24c"

/**
 * The file extension of one autocomplete index file, a sealed ancestrie.
 */
export const AUTOCOMPLETE_INDEX_EXTENSION = ".anct"

/**
 * Returns the URL of the autocomplete index file for one leading-character partition.
 */
export function autocompleteIndexURL(partition: string): string {
	return `${ASSET_BASE_URL}autocomplete/${AUTOCOMPLETE_INDEX_VERSION}/${partition}${AUTOCOMPLETE_INDEX_EXTENSION}`
}

/**
 * Returns the URL of the autocomplete index manifest.
 * The manifest lists the partitions the generation holds.
 */
export function autocompleteIndexManifestURL(): string {
	return `${ASSET_BASE_URL}autocomplete/${AUTOCOMPLETE_INDEX_VERSION}/index.json`
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
export function regionToStateSlug(region: string | null): string | null {
	if (!region) return null
	const r = region.trim().toLowerCase()

	if (/^[a-z]{2}$/.test(r)) return r

	return US_STATE_NAME_TO_SLUG[r] ?? null
}

/**
 * Returns the loader URL configuration shared by the primary and comparison classifiers.
 *
 * Both load every pair index the generation's manifest lists.
 * The loader keeps each live and `selectPairIndexForText` picks per parse.
 *
 * A missing binary is skipped, so it means no prior, never a failed load.
 */
export function neuralClassifierLoadURLs(
	locale: string,
	version: string,
	opts: {
		postcodeAnchors: readonly string[]
		/**
		 * The countries the pair-index generation's manifest lists, as lowercase alpha-2 codes.
		 */
		pairIndexCountries: readonly string[]
		postcodePrefixes?: readonly string[]
		splitEmbeddings?: boolean
	}
): NeuralClassifierLoadURLs {
	return {
		// A split release loads the encoder and reads the embedding rows separately.
		// Its directory still holds `model.onnx` for runtimes that predate the split.
		...(opts.splitEmbeddings
			? {
					modelURL: assetURL(locale, version, "encoder.onnx"),
					embeddings: {
						hotURL: assetURL(locale, version, "embeddings-hot.bin"),
						rowsURL: assetURL(locale, version, "embeddings.rows"),
					},
				}
			: { modelURL: assetURL(locale, version, "model.onnx") }),
		tokenizerURL: assetURL(locale, version, "tokenizer.model"),
		modelCardURL: assetURL(locale, version, "model-card.json"),
		// Gazetteer-trained bundles require the lexicon.
		// Older releases may not include it.
		gazetteerLexicon: { url: assetURL(locale, version, "anchor-lexicon-v1.json") },
		postcodeBinaryURLs: opts.postcodeAnchors.map((file) => assetURL(locale, version, file)),
		// The postcode-prefix indexes sit in the release directory beside the postcode binaries.
		postcodePrefixURLs: (opts.postcodePrefixes ?? []).map((file) => assetURL(locale, version, file)),
		// The pair indexes live on the public bucket beside every other model asset,
		// under a dated generation: the objects ship an immutable Cache-Control,
		// so a rebuilt index is readable only from a fresh path.
		pairIndexURLs: pairIndexURLs(pairIndexBaseURL(PAIR_INDEX_VERSION), opts.pairIndexCountries),
	}
}

/**
 * The loader URL configuration of a SentencePiece release, as {@link neuralClassifierLoadURLs} returns it.
 *
 * A split release sets `embeddings`, and its `modelURL` is `encoder.onnx`.
 */
export interface NeuralClassifierLoadURLs {
	modelURL: string
	embeddings?: { hotURL: string; rowsURL: string }
	tokenizerURL: string
	modelCardURL: string
	gazetteerLexicon: { url: string }
	postcodeBinaryURLs: string[]
	postcodePrefixURLs: string[]
	pairIndexURLs: string[]
}

/**
 * The loader URL configuration of a character-encoder release.
 *
 * The graph reads code points indexed by `char-vocab.json` beside `model.onnx`, so there is no tokenizer.
 * The character family ships no postcode binaries, prefix indexes or pair indexes,
 * so each of those lists is empty.
 */
export interface CharClassifierLoadURLs {
	modelURL: string
	charVocabURL: string
	modelCardURL: string
	postcodeBinaryURLs: readonly string[]
	postcodePrefixURLs: readonly string[]
	pairIndexURLs: readonly string[]
}

/**
 * Returns the loader URL configuration of a character-encoder release.
 */
export function charClassifierLoadURLs(locale: string, version: string): CharClassifierLoadURLs {
	return {
		modelURL: assetURL(locale, version, "model.onnx"),
		charVocabURL: assetURL(locale, version, "char-vocab.json"),
		modelCardURL: assetURL(locale, version, "model-card.json"),
		postcodeBinaryURLs: [],
		postcodePrefixURLs: [],
		pairIndexURLs: [],
	}
}

/**
 * Reports whether a loader URL configuration is a character-encoder release's.
 */
export function isCharClassifierLoadURLs(
	urls: NeuralClassifierLoadURLs | CharClassifierLoadURLs
): urls is CharClassifierLoadURLs {
	return "charVocabURL" in urls
}

/**
 * Version of the pair-index binaries.
 * Update it with each rebuild.
 *
 * The site pins this version because its bundled reader accepts only one schema version.
 * The `2026-10-17` generation holds the Great Britain index built without HM Land Registry Price Paid Data.
 */
export const PAIR_INDEX_VERSION = "2026-10-17"

/**
 * Returns the base URL of one pair-index version.
 */
export function pairIndexBaseURL(version: string): string {
	return `${ASSET_BASE_URL}pair-index/${version}`
}

/**
 * Returns the URL of the manifest beside one pair-index generation's binaries.
 *
 * The publisher writes `index.json` from the binaries it stages, so the runtime asks the bucket
 * which countries a generation holds rather than listing them in code.
 */
export function pairIndexManifestURL(baseURL: string): string {
	return `${baseURL.replace(/\/$/, "")}/index.json`
}

/**
 * Returns the per-country binary URLs under a pair-index base URL.
 *
 * @param baseURL Base URL of the binaries, with or without a trailing slash.
 * @param countries The lowercase alpha-2 codes the generation's manifest lists.
 */
export function pairIndexURLs(baseURL: string, countries: readonly string[]): string[] {
	const base = baseURL.replace(/\/$/, "")

	return countries.map((cc) => `${base}/pair-index-${cc}.bin`)
}

/**
 * Loads the release's FST gazetteer and, when the binary includes it, its provenance.
 */
export async function loadFSTGazetteer(
	locale: string,
	version: string
): Promise<{ matcher: FSTMatcherLike; provenance: FSTProvenance | null }> {
	const [fstModule, fstBinary] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web"),
		fetchWithRetry(assetURL(locale, version, "fst-en-US.bin")).then((r) => {
			if (!r.ok) throw new Error(`FST fetch failed (${r.status})`)

			return r.arrayBuffer()
		}),
	])

	const matcher = fstModule.deserializeFSTWeb(fstBinary) as FSTMatcherLike
	let provenance: FSTProvenance | null = null

	try {
		provenance = (fstModule.readFSTProvenanceWeb(fstBinary) as FSTProvenance | undefined) ?? null
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
