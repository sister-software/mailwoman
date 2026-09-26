/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Surface-form primitives for the sub-venue lexicon: the normalizer every phrase passes through, the phrase → record index, and the operator that decides whether a feature's name contains a known designator.
 *
 * The two matching rules are script-conditional, and both narrowings are required.
 */

import { normalizeWhitespace } from "@mailwoman/core/strings/format"

import type { SubVenueSurface } from "#tools/sub/venue/table"

/**
 * Scripts whose case is meaningful to fold; everything else is left as written.
 */
const CASE_FOLDING_SCRIPT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s\p{P}]+$/u

/**
 * Scripts written without spaces between words, where a token split cannot find a
 * designator and a substring test is the correct operator.
 *
 * Han, Hiragana and Katakana; Hangul is excluded because Korean does space its words.
 * The Germanic-compound argument that keeps {@link nameContainsSurfaces}
 * token-bounded for Latin does not transfer here.
 */
const NON_SPACING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * Normalize a surface for the table: trim, collapse internal whitespace, and lowercase only
 * when the string is entirely in a bicameral script.
 */
export function normalizeSurface(text: string): string {
	const trimmed = normalizeWhitespace(text)

	return CASE_FOLDING_SCRIPT.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

/**
 * A phrase → record index keyed on the normalized phrase, which is how a matched
 * phrase is attributed to the record it names.
 */
export type SurfaceIndex = ReadonlyMap<string, { recordID: string; recordKind: "designator" | "modifier" }>

/**
 * Index the surfaces accumulated so far by phrase.
 *
 * First writer wins, so a seed record beats a Wikidata alias that happens to collide.
 */
export function buildSurfaceIndex(surfaces: readonly SubVenueSurface[]): SurfaceIndex {
	const index = new Map<string, { recordID: string; recordKind: "designator" | "modifier" }>()

	for (const surface of surfaces) {
		if (index.has(surface.phrase)) continue
		index.set(surface.phrase, { recordID: surface.recordID, recordKind: surface.recordKind })
	}

	return index
}

/**
 * Every known phrase found in `name`, as whole-token runs for spacing scripts
 * and as substrings for non-spacing ones.
 *
 * Latin matching is token-bounded rather than substring, so `Nordterminal` is a deliberate miss;
 * Han and Kana have no word boundaries, so the longest known substring is the correct operator there.
 */
export function nameContainsSurfaces(name: string, index: SurfaceIndex): string[] {
	const normalized = normalizeSurface(name)
	const hits = new Set<string>()

	for (const token of normalized.split(/[\s,()/]+/u)) {
		const stripped = token.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")

		if (stripped && index.has(stripped)) {
			hits.add(stripped)
		}
	}

	if (NON_SPACING_SCRIPT.test(normalized)) {
		for (const [phrase] of index) {
			if (NON_SPACING_SCRIPT.test(phrase) && normalized.includes(phrase)) {
				hits.add(phrase)
			}
		}
	}

	return [...hits]
}
