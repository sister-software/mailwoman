/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Browser placetype-pair index loading and selection.
 */

import { detectLocale } from "@mailwoman/locale-hint"
import { computeQueryShape } from "@mailwoman/query-shape"

import { PairIndexResolver } from "#pair/index/resolver"
import type { PlacetypePairPriorOpts } from "#placetype/pair-prior"
import type { LoadedPairIndex } from "#web/loader"
import { fetchBytes } from "#web/onnx-runner"

/**
 * Reduce a locale or bare country code to the country subtag the pair-index restriction compares.
 *
 * A full locale ("en-gb") yields its subtag ("gb") and a bare code ("gb") passes through
 * unchanged.
 * An omitted country defaults to "en-us" and therefore to "us".
 */
export function resolvePairIndexCountry(country: string | undefined): string {
	const normalized = (country ?? "en-us").toLowerCase()

	return normalized.split("-")[1] ?? normalized
}

/**
 * Fetch and construct the PIX1 placetype-pair indexes tolerantly, where each `pair-index-<cc>.bin`
 * is optional so a 404, a network failure or a corrupt binary is skipped with a `console.warn`
 * that reports the URL and the classifier load continues.
 *
 * Every successfully fetched index is constructed into a live {@link PairIndexResolver} tagged by
 * its header country, and the per-parse selection ({@link resolvePairIndexForText}) chooses among
 * them at decode time.
 * A session that serves a US and a GB address needs both resolvers live.
 */
export async function loadPairIndexes(urls: readonly string[], fetchImpl: typeof fetch): Promise<LoadedPairIndex[]> {
	const settled = await Promise.all(
		urls.map(async (url): Promise<LoadedPairIndex | null> => {
			try {
				const resolver = new PairIndexResolver(await fetchBytes(url, fetchImpl))

				return { url, country: resolver.header.country, resolver }
			} catch (error) {
				console.warn(
					`[@mailwoman/neural/web-loader] optional placetype-pair index skipped: ${url} — ` +
						`${error instanceof Error ? error.message : String(error)}. ` +
						"The pair prior is a soft decode channel; the classifier loads without it (no placetype-pair bias only)."
				)

				return null
			}
		})
	)

	return settled.filter((index): index is LoadedPairIndex => index !== null)
}

/**
 * Detect the placetype-pair country subtag for one input from its structural shape.
 *
 * The detection keys off universal cues (postcode format, script class) rather than place-name
 * dictionaries, so "10 Downing St, London SW1A 2AA" detects `gb` while a bare "Shoreditch
 * London" falls through to the `en-US` fallback and therefore to `us`.
 */
export function detectPairIndexCountry(text: string): string {
	const shape = computeQueryShape(text)
	const hint = detectLocale(shape)

	return resolvePairIndexCountry(hint.locale)
}

/**
 * Select the placetype-pair prior for one parse.
 *
 * The country subtag comes from an explicit `opts.country` override when given, else from
 * {@link detectPairIndexCountry} over `text`, and the loaded index whose header country matches
 * is returned as a `placetypePair` option.
 * No matching index returns `undefined`, which produces a byte-stable no-prior decode.
 */
export function resolvePairIndexForText(
	pairIndexes: readonly LoadedPairIndex[],
	text: string,
	opts?: { country?: string }
): PlacetypePairPriorOpts | undefined {
	if (!pairIndexes.length) return undefined
	const country = opts?.country != null ? resolvePairIndexCountry(opts.country) : detectPairIndexCountry(text)
	const match = pairIndexes.find((index) => index.country === country)

	return match ? { index: match.resolver } : undefined
}
