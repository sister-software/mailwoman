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
 * Reduce {@link LoadFromURLsOptions.country} to the bare country code the pair-index restriction compares. A full locale
 * ("en-gb") yields its country subtag ("gb") — the node classifier's exact `localeCountry` derivation — and a bare code
 * ("gb") passes through unchanged (a browser-side widening: the node path only ever receives locales). Omitted =
 * `"en-us"` → `"us"`, the node default.
 */
export function resolvePairIndexCountry(country: string | undefined): string {
	const normalized = (country ?? "en-us").toLowerCase()

	return normalized.split("-")[1] ?? normalized
}

/**
 * Fetch + construct the PIX1 placetype-pair indexes TOLERANTLY (the {@link loadPostcodeAnchorLookup} contract): each
 * `pair-index-<cc>.bin` is OPTIONAL, so a 404/network failure/corrupt binary (bad magic, truncated header) is skipped
 * with a loud `console.warn` naming the URL — never a rejection that blocks the classifier load. Older HF release
 * versions ship no pair indexes at all, and the prior is a soft decode channel, not a required model input.
 *
 * **Phase 2 (#1278): NO load-time country restriction.** Every successfully-fetched index is constructed into a live
 * {@link PairIndexResolver} and retained, tagged by its header country. The per-parse selection
 * ({@link resolvePairIndexForText}) chooses among them at decode time from the input text's detected country — a load
 * that serves a US and a GB address in one session needs BOTH resolvers live. (#1300 constructed only the single
 * matching index; that peek-before-construct economy is dropped deliberately — the multi-locale demo needs them all,
 * and a handful of small pair maps is cheap.)
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
 * Detect the placetype-pair country subtag for one input from its STRUCTURAL shape (#1278 phase 2). Runs the two
 * browser-safe Stage-2 modules the runtime pipeline uses — `@mailwoman/query-shape`'s `computeQueryShape` then
 * `@mailwoman/locale-hint`'s `detectLocale` — and reduces the resulting `LocaleHint.locale` (e.g. "en-GB") to its
 * country subtag ("gb") via {@link resolvePairIndexCountry}.
 *
 * The detection is bitter-lesson-safe by construction: locale-hint keys ONLY off universal cues (postcode format,
 * script class), never place-name dictionaries. So "10 Downing St, London SW1A 2AA" detects `gb` (UK postcode), but a
 * bare "Shoreditch London" — no postcode, Latin script — falls through to locale-hint's `en-US` fallback → `us`. The
 * pair prior is a soft, additive channel, so a conservative miss (no bias) is the safe failure mode.
 */
export function detectPairIndexCountry(text: string): string {
	const shape = computeQueryShape(text)
	const hint = detectLocale(shape)

	return resolvePairIndexCountry(hint.locale)
}

/**
 * Select the placetype-pair prior for one parse (#1278 phase 2). Derives a country subtag — from an explicit
 * `opts.country` override when given, else {@link detectPairIndexCountry} over `text` — and returns the loaded index
 * whose header country matches, wrapped as a `placetypePair` option (`{ index }` alone: probe chain defaults to "auto",
 * `delta`/`transitionBeta` ride the resolver's header getters, exactly the node construction). No matching index →
 * `undefined` (the caller spreads `placetypePair: undefined` → byte-stable no-prior decode, or fall-through to a config
 * default). See {@link LoadResult.selectPairIndexForText} for the bound convenience + call-site example.
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
