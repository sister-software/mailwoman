/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The postcode-only fallback's reading of an input.
 *
 *   When the gazetteer cascade answers no place, the fallback tries postcode keys against a centroid map.
 *   The keys come from the parse's postcode node and from the input's known postcode formats.
 *   A postcode the classifier labeled at low confidence, or left unlabeled, therefore still reaches the map.
 *   The map merges the classifier's anchors with the binaries a release lists for the fallback only.
 */

import { anchorLookupFromPostcodes } from "@mailwoman/neural/anchor-inference"
import { PostcodeBinaryResolver } from "@mailwoman/postcode/binary-resolver"
import { isPostcodeFormat } from "@mailwoman/query-shape/known-formats"
import type { KnownFormatHitView } from "@mailwoman/query-shape/types"

/**
 * A centroid per postcode key, the map the postcode-only fallback reads.
 */
export type PostcodeCentroidLookup = Map<string, { lat: number; lon: number }>

/**
 * Punctuation or symbols at either end of a written postcode.
 *
 * Examples are the postal mark U+3012 a sender writes before a Japanese postcode, and a trailing period.
 * The tokenizer keeps them attached to the digits.
 */
const EDGE_MARKS = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

/**
 * The centroid map's key for one written postcode, or null when the writing holds no postcode body.
 *
 * The map keys postcodes as the Who's On First extracts write them: uppercase, with internal separators.
 * The written form keeps its separators and loses only the marks at its edges.
 */
export function centroidLookupKey(written: string): string | null {
	const key = written.trim().replace(EDGE_MARKS, "").toUpperCase()

	return key || null
}

/**
 * The postcode keys the fallback tries, in order, without repeats.
 *
 * The parse's postcode node comes first, then every known postcode format the
 * query shape found in the input.
 * A known format is read from the input's own characters.
 *
 * The classifier's confidence in the span therefore plays no part in whether the postcode is tried.
 */
export function postcodeFallbackKeys(
	parsedPostcode: string | null,
	input: string,
	knownFormats: ReadonlyArray<KnownFormatHitView>
): string[] {
	const written = [
		...(parsedPostcode ? [parsedPostcode] : []),
		...knownFormats
			.filter((hit) => isPostcodeFormat(hit.format))
			.map((hit) => input.slice(hit.span.start, hit.span.end)),
	]

	const keys: string[] = []

	for (const text of written) {
		const key = centroidLookupKey(text)

		if (key && !keys.includes(key)) {
			keys.push(key)
		}
	}

	return keys
}

/**
 * The first centroid the map holds for any of `keys`, with the key that found it, or null.
 *
 * A `(0, 0)` centroid is the extract's unplaced sentinel and never answers.
 */
export function postcodeCentroidFor(
	lookup: PostcodeCentroidLookup,
	keys: readonly string[]
): { key: string; lat: number; lon: number } | null {
	for (const key of keys) {
		const centroid = lookup.get(key)

		if (centroid && (centroid.lat !== 0 || centroid.lon !== 0)) {
			return { key, lat: centroid.lat, lon: centroid.lon }
		}
	}

	return null
}

/**
 * Reads PCB1 binaries into one centroid map.
 *
 * Each postcode's centroid is the mean of its placed records.
 * Only the postcode-only fallback reads these binaries.
 *
 * The classifier's anchor channel reads the release's `postcodeAnchors`,
 * so a binary listed here changes no model input.
 */
export async function loadPostcodeCentroids(
	urls: readonly string[],
	fetchImpl: typeof fetch = fetch
): Promise<PostcodeCentroidLookup> {
	const lookups = await Promise.all(
		urls.map(async (url) => {
			const response = await fetchImpl(url)

			if (!response.ok) {
				throw new Error(`postcode centroids: ${url} answered ${response.status}`)
			}

			return anchorLookupFromPostcodes(
				new PostcodeBinaryResolver(new Uint8Array(await response.arrayBuffer())).groups()
			)
		})
	)

	const merged: PostcodeCentroidLookup = new Map()

	for (const lookup of lookups) {
		for (const [key, entry] of lookup) {
			merged.set(key, { lat: entry.lat, lon: entry.lon })
		}
	}

	return merged
}

/**
 * One map over the classifier's anchor lookup and the fallback-only centroids.
 *
 * The anchor lookup's entry wins a key both hold.
 */
export function mergePostcodeCentroids(
	anchors: PostcodeCentroidLookup | null,
	centroids: PostcodeCentroidLookup | null
): PostcodeCentroidLookup | null {
	if (!centroids?.size) return anchors

	const merged: PostcodeCentroidLookup = new Map(centroids)

	for (const [key, entry] of anchors ?? []) {
		merged.set(key, entry)
	}

	return merged
}
